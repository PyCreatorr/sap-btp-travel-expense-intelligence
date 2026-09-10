"use strict";

// -----------------------------------------------------------------------------
// Test environment
// -----------------------------------------------------------------------------
// The service normally expects an LLM configuration during startup.
// These tests call only validate and matchDMO, so no real API call is required.
process.env.NODE_ENV = "test";
process.env.CDS_TEST_ENV_CHECK = "y";
process.env.LLM_PROVIDER = "GEMINI";
process.env.GEMINI_API_KEY = "integration-test-dummy-key";

const path = require("node:path");
const cds = require("@sap/cds");

// Start the real CAP application from the project root.
// cds.test() also provides the HTTP helpers and Chai assertions.
const projectRoot = path.join(__dirname, "..");
const { POST, GET, expect, data } = cds.test(projectRoot);

// CAP query builders used for direct test-data preparation.
const { INSERT, UPDATE, DELETE } = cds.ql;

// -----------------------------------------------------------------------------
// Fixed IDs used only by this integration test
// -----------------------------------------------------------------------------
const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "697";
const TRAVEL_ID_DB = "10";
const TRAVEL_ID_RECEIPT = "00000010";

// This object represents the structured JSON that the extraction step would
// normally create from a PDF receipt.
const validExtraction = {
  documentType: "AIR",
  receiptNo: "CT-2025-00010",
  receiptDate: "2025-11-18",
  travelId: TRAVEL_ID_RECEIPT,
  supplier: "Ali's Bazar",
  currency: "USD",
  totalAmount: 957.8,
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
      carrierId: null,
      flightNumber: null,
      bookingId: null,
      dmoConnectionId: null,
      flightDate: null,
    },
    {
      type: "Taxes",
      description: "Taxes and fees",
      amount: 27.8,
      currency: "USD",
      carrierId: null,
      flightNumber: null,
      bookingId: null,
      dmoConnectionId: null,
      flightDate: null,
    },
  ],
};

// -----------------------------------------------------------------------------
// Database preparation
// -----------------------------------------------------------------------------
async function cleanDatabase() {
  const db = await cds.connect.to("db");

  // data.reset() recreates the schema but can also reload CSV demo data.
  // We therefore remove the records used by this test and insert a controlled
  // scenario afterward. Child records must be deleted before parent records.
  await db.run(DELETE.from("demo.copilot.Bookings"));
  await db.run(DELETE.from("demo.copilot.Receipt"));
  await db.run(DELETE.from("demo.copilot.Travels"));
  await db.run(DELETE.from("demo.copilot.Customers"));
}

async function seedDatabase(extractedJson = validExtraction) {
  const db = await cds.connect.to("db");

  // 1. Customer required by the travel and by matchDMO.
  await db.run(
    INSERT.into("demo.copilot.Customers").entries({
      CustomerID: CUSTOMER_ID,
      FirstName: "John",
      LastName: "Integration",
      Title: "Mr.",
      Street: "Test Street 1",
      PostalCode: "89073",
      City: "Ulm",
      CountryCode: "DE",
      PhoneNumber: "+49 731 000000",
      EmailAddress: "integration.test@example.com",
    })
  );

  // 2. One DMO travel belonging to that customer.
  await db.run(
    INSERT.into("demo.copilot.Travels").entries({
      TravelID: TRAVEL_ID_DB,
      AgencyID: "70016",
      CustomerID: CUSTOMER_ID,
      BeginDate: "2025-11-22",
      EndDate: "2025-11-24",
      BookingFee: 20,
      TotalPrice: 957.8,
      CurrencyCode: "USD",
      Description: "Business Trip to USA",
      Status: "N",
    })
  );

  // 3. Two DMO bookings belonging to the travel.
  await db.run(
    INSERT.into("demo.copilot.Bookings").entries([
      {
        TravelID: TRAVEL_ID_DB,
        BookingID: "1",
        BookingDate: "2025-11-06",
        CustomerID: CUSTOMER_ID,
        CarrierID: "UA",
        ConnectionID: "1537",
        FlightDate: "2025-11-22",
        FlightPrice: 455,
        CurrencyCode: "USD",
      },
      {
        TravelID: TRAVEL_ID_DB,
        BookingID: "2",
        BookingDate: "2025-11-18",
        CustomerID: CUSTOMER_ID,
        CarrierID: "AA",
        ConnectionID: "322",
        FlightDate: "2025-11-24",
        FlightPrice: 455,
        CurrencyCode: "USD",
      },
    ])
  );

  // 4. The application receipt that the OData actions will read and update.
  // The database entity is singular: demo.copilot.Receipt.
  await db.run(
    INSERT.into("demo.copilot.Receipt").entries({
      ID: RECEIPT_ID,
      fileName: "integration-test.pdf",
      mimeType: "application/pdf",
      extractedText: "Synthetic integration-test receipt",
      extractedJson: JSON.stringify(extractedJson),
      travelId: TRAVEL_ID_RECEIPT,
      currency: "USD",
      totalAmount: 957.8,
      receiptDate: "2025-11-18",
      status: "EXTRACTED",
    })
  );
}

function parseLargeStringResponse(response) {
  // CAP returns LargeString action results inside response.data.value.
  return JSON.parse(response.data.value);
}

// -----------------------------------------------------------------------------
// Integration tests
// -----------------------------------------------------------------------------
describe("CopilotService validate and DMO matching integration", () => {
  beforeEach(async () => {
    // Critical safety check: never reset or delete the persistent development DB.
    expect(cds.env.requires.db.credentials.url).to.equal(":memory:");

    // Every test starts with the same clean and predictable database state.
    await data.reset();
    await cleanDatabase();
    await seedDatabase();
  });

  it("validates a structurally correct receipt through the real OData endpoint", async () => {
    const response = await POST("/odata/v4/copilot/validate", {
      receiptId: RECEIPT_ID,
    });

    const result = parseLargeStringResponse(response);

    expect(response.status).to.equal(200);
    expect(result.ok).to.equal(true);
    expect(result.severity).to.equal("OK");
    expect(result.missing).to.deep.equal([]);
    expect(result.warnings).to.deep.equal([]);

    expect(result.checks.extracted.documentType).to.equal(true);
    expect(result.checks.extracted.receiptNo).to.equal(true);
    expect(result.checks.extracted.receiptDate).to.equal(true);
    expect(result.checks.extracted.currency).to.equal(true);
    expect(result.checks.extracted.totalAmount).to.equal(true);
    expect(result.checks.extracted.travelId).to.equal(true);

    expect(result.checks.items).to.have.length(4);
    expect(result.checks.items[0].type).to.equal("Airfare");
    expect(result.checks.items[0].ok).to.equal(true);
    expect(result.checks.items[1].type).to.equal("Airfare");
    expect(result.checks.items[1].ok).to.equal(true);
    expect(result.checks.items[2].type).to.equal("Fee");
    expect(result.checks.items[3].type).to.equal("Taxes");

    expect(result.checks.totals.extractedItemSum).to.equal(957.8);
    expect(result.checks.totals.extractedTotal).to.equal(957.8);
    expect(result.checks.totals.extractedDiff).to.equal(0);
    expect(result.checks.totals.itemSumMatchesTotal).to.equal(true);
  });

  it("persists the VALIDATED status in the in-memory database", async () => {
    await POST("/odata/v4/copilot/validate", {
      receiptId: RECEIPT_ID,
    });

    // The OData service entity is plural: Receipts.
    const response = await GET(
      `/odata/v4/copilot/Receipts(${RECEIPT_ID})?$select=ID,status`
    );

    expect(response.status).to.equal(200);
    expect(response.data.ID).to.equal(RECEIPT_ID);
    expect(response.data.status).to.equal("VALIDATED");
  });

  it("reports a warning when one airfare item has no matching DMO booking", async () => {
    const suspiciousExtraction = structuredClone(validExtraction);

    // Replace the second real booking with a flight that does not exist in the
    // seeded DMO data. The receipt total remains unchanged intentionally.
    suspiciousExtraction.items[1] = {
      type: "Airfare",
      description: "Nonexistent flight booking",
      amount: 455,
      currency: "USD",
      carrierId: "LH",
      flightNumber: "9999",
      bookingId: "9999",
      dmoConnectionId: null,
      flightDate: "2025-12-10",
    };

    const db = await cds.connect.to("db");
    await db.run(
      UPDATE("demo.copilot.Receipt")
        .set({
          extractedJson: JSON.stringify(suspiciousExtraction),
          status: "EXTRACTED",
        })
        .where({ ID: RECEIPT_ID })
    );

    const response = await POST("/odata/v4/copilot/matchDMO", {
      receiptId: RECEIPT_ID,
    });

    const result = parseLargeStringResponse(response);

    expect(response.status).to.equal(200);
    expect(result.matchedTravelId).to.equal(TRAVEL_ID_DB);

    // There are two bookings in DMO, but only the first one matches the receipt.
    expect(result.technical.allDmoBookingCount).to.equal(2);
    expect(result.technical.matchedDmoBookingCount).to.equal(1);
    expect(result.technical.unmatchedDmoBookingCount).to.equal(1);

    expect(result.matchedBookings).to.have.length(1);
    expect(result.matchedBookings[0].bookingId).to.equal("1");
    expect(result.warnings.length).to.be.greaterThan(0);

    expect(
      result.warnings.some((warning) =>
        warning.includes("differs from matched DMO booked airfare total")
      )
    ).to.equal(true);
  });

  it("returns FAIL when a required extracted field is missing", async () => {
    const incompleteExtraction = structuredClone(validExtraction);
    delete incompleteExtraction.receiptNo;

    const db = await cds.connect.to("db");
    await db.run(
      UPDATE("demo.copilot.Receipt")
        .set({
          extractedJson: JSON.stringify(incompleteExtraction),
          status: "EXTRACTED",
        })
        .where({ ID: RECEIPT_ID })
    );

    const response = await POST("/odata/v4/copilot/validate", {
      receiptId: RECEIPT_ID,
    });

    const result = parseLargeStringResponse(response);

    expect(response.status).to.equal(200);
    expect(result.ok).to.equal(false);
    expect(result.severity).to.equal("FAIL");
    expect(result.missing).to.include("receiptNo");
  });
});
