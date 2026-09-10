/*
 * Unit tests for srv/handlers/validate.js
 *
 * Run from the CAP project root:
 *   node --test test/validate.unit.test.js
 *
 * These tests use Node's built-in test runner and do not call:
 * - OpenAI or Gemini
 * - SAP HANA Cloud
 * - external APIs
 * - the CAP HTTP/OData server
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const originalConsoleLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalConsoleLog;
});

const registerValidateHandler = require("../srv/handlers/validate.js");

function buildValidExtraction(overrides = {}) {
  const extraction = {
    documentType: "AIR",
    receiptNo: "CT-TEST-0001",
    receiptDate: "2026-01-08",
    travelId: "00000010",
    supplier: "Test Travel Agency",
    currency: "USD",
    totalAmount: 957.8,
    customers: [
      {
        customerId: "000697",
        name: "Test Traveler",
        role: "Employee/Traveler",
      },
    ],
    customerCount: 1,
    flightLegs: [
      {
        leg: 1,
        carrierId: "UA",
        flightNumber: "1537",
        route: "EWR -> MIA",
        fromAirport: "EWR",
        toAirport: "MIA",
        flightDate: "2025-11-22",
        farePerPassenger: 455,
        currency: "USD",
      },
      {
        leg: 2,
        carrierId: "AA",
        flightNumber: "0322",
        route: "MIA -> EWR",
        fromAirport: "MIA",
        toAirport: "EWR",
        flightDate: "2025-11-24",
        farePerPassenger: 455,
        currency: "USD",
      },
    ],
    items: [
      {
        type: "Airfare",
        description: "Flight fare - Leg 1",
        amount: 455,
        currency: "USD",
        carrierId: "UA",
        flightNumber: "1537",
        bookingId: "0001",
        dmoConnectionId: null,
        flightDate: "2025-11-22",
      },
      {
        type: "Airfare",
        description: "Flight fare - Leg 2",
        amount: 455,
        currency: "USD",
        carrierId: "AA",
        flightNumber: "0322",
        bookingId: "0002",
        dmoConnectionId: null,
        flightDate: "2025-11-24",
      },
      {
        type: "Fee",
        description: "Agency booking fee",
        amount: 20,
        currency: "USD",
      },
      {
        type: "Taxes",
        description: "Taxes and fees",
        amount: 27.8,
        currency: "USD",
      },
    ],
  };

  return Object.assign(extraction, overrides);
}

function createHarness(receipt) {
  const Receipts = { name: "CopilotService.Receipts" };
  const handlers = new Map();
  const rows = new Map();
  const updateCalls = [];

  if (receipt) {
    rows.set(receipt.ID, structuredClone(receipt));
  }

  const service = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  const SELECT = {
    one: {
      from() {
        return {
          async where(condition) {
            return rows.get(condition.ID) ?? null;
          },
        };
      },
    },
  };

  const UPDATE = () => ({
    set(changes) {
      return {
        async where(condition) {
          const existing = rows.get(condition.ID);
          if (!existing) return 0;

          updateCalls.push({ ID: condition.ID, changes: structuredClone(changes) });
          rows.set(condition.ID, { ...existing, ...changes });
          return 1;
        },
      };
    },
  });

  registerValidateHandler(service, {
    SELECT,
    UPDATE,
    entities: { Receipts },
  });

  const validate = handlers.get("validate");
  assert.equal(typeof validate, "function", "validate handler was not registered");

  function request(receiptId) {
    return {
      data: { receiptId },
      reject(status, message) {
        const error = new Error(message);
        error.status = status;
        throw error;
      },
    };
  }

  return {
    validate,
    request,
    rows,
    updateCalls,
  };
}

function createReceipt(extractedJson, overrides = {}) {
  return {
    ID: "11111111-1111-4111-8111-111111111111",
    fileName: "test-receipt.pdf",
    mimeType: "application/pdf",
    extractedJson:
      typeof extractedJson === "string"
        ? extractedJson
        : JSON.stringify(extractedJson),
    travelId: extractedJson?.travelId ?? "00000010",
    currency: extractedJson?.currency ?? "USD",
    totalAmount: extractedJson?.totalAmount ?? 957.8,
    receiptDate: extractedJson?.receiptDate ?? "2026-01-08",
    status: "EXTRACTED",
    ...overrides,
  };
}

async function executeValidation(extracted, receiptOverrides = {}) {
  const receipt = createReceipt(extracted, receiptOverrides);
  const harness = createHarness(receipt);
  const json = await harness.validate(harness.request(receipt.ID));

  return {
    result: JSON.parse(json),
    receipt,
    harness,
  };
}

test("complete receipt returns OK and changes status to VALIDATED", async () => {
  const { result, receipt, harness } = await executeValidation(
    buildValidExtraction()
  );

  assert.equal(result.ok, true);
  assert.equal(result.severity, "OK");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.checks.totals.itemSumMatchesTotal, true);
  assert.equal(result.checks.totals.extractedDiff, 0);
  assert.equal(result.summary.statusBefore, "EXTRACTED");
  assert.equal(result.summary.statusAfter, "VALIDATED");

  assert.equal(harness.rows.get(receipt.ID).status, "VALIDATED");
  assert.equal(harness.updateCalls.length, 1);
  assert.deepEqual(harness.updateCalls[0].changes, { status: "VALIDATED" });
});

test("missing required receipt number returns FAIL", async () => {
  const extracted = buildValidExtraction();
  delete extracted.receiptNo;

  const { result } = await executeValidation(extracted);

  assert.equal(result.ok, false);
  assert.equal(result.severity, "FAIL");
  assert.ok(result.missing.includes("receiptNo"));
  assert.equal(result.checks.extracted.receiptNo, false);
});

test("missing optional supplier returns WARN but remains processable", async () => {
  const extracted = buildValidExtraction({ supplier: null });
  const { result } = await executeValidation(extracted);

  assert.equal(result.ok, true);
  assert.equal(result.severity, "WARN");
  assert.equal(result.checks.extracted.supplier, false);
  assert.ok(result.warnings.some((warning) => warning.includes("Supplier missing")));
});

test("item-total mismatch is detected", async () => {
  const extracted = buildValidExtraction({ totalAmount: 1000 });
  const { result } = await executeValidation(extracted);

  assert.equal(result.ok, true);
  assert.equal(result.severity, "WARN");
  assert.equal(result.checks.totals.extractedItemSum, 957.8);
  assert.equal(result.checks.totals.extractedTotal, 1000);
  assert.equal(result.checks.totals.extractedDiff, 42.2);
  assert.equal(result.checks.totals.itemSumMatchesTotal, false);
  assert.ok(result.warnings.some((warning) => warning.includes("Item sum")));
});

test("invalid currency, date, flight number and negative amount create warnings", async () => {
  const extracted = buildValidExtraction({
    currency: "US",
    receiptDate: "not-a-date",
    totalAmount: -1,
  });

  extracted.flightLegs[0].flightDate = "invalid-flight-date";
  extracted.items[0].flightNumber = "UA-1537";
  extracted.items[0].currency = "EUR";

  const { result } = await executeValidation(extracted);

  assert.equal(result.ok, true);
  assert.equal(result.severity, "WARN");
  assert.ok(result.warnings.some((warning) => warning.includes("ISO currency code")));
  assert.ok(result.warnings.some((warning) => warning.includes("Total amount is negative")));
  assert.ok(result.warnings.some((warning) => warning.includes("not a valid date")));
  assert.ok(result.warnings.some((warning) => warning.includes("digits only")));
  assert.ok(result.warnings.some((warning) => warning.includes("differs from receipt currency")));
});

test("an already validated receipt is not updated again", async () => {
  const receipt = createReceipt(buildValidExtraction(), { status: "VALIDATED" });
  const harness = createHarness(receipt);

  const json = await harness.validate(harness.request(receipt.ID));
  const result = JSON.parse(json);

  assert.equal(result.summary.statusBefore, "VALIDATED");
  assert.equal(result.summary.statusAfter, "VALIDATED");
  assert.equal(harness.updateCalls.length, 0);
});

test("invalid extracted JSON is rejected with HTTP-style status 400", async () => {
  const receipt = createReceipt("{invalid-json");
  const harness = createHarness(receipt);

  await assert.rejects(
    () => harness.validate(harness.request(receipt.ID)),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Extracted JSON is invalid/);
      return true;
    }
  );
});

test("unknown receipt is rejected with HTTP-style status 404", async () => {
  const harness = createHarness(null);

  await assert.rejects(
    () => harness.validate(harness.request("missing-receipt")),
    (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /Receipt not found/);
      return true;
    }
  );
});
