/**
 * CopilotService runtime implementation
 *
 * Architecture:
 *   copilot-service.cds  -> public OData service contract
 *   copilot-service.js   -> service wiring and orchestration
 *   handlers/*           -> modular workflow business logic
 *   adapters/*           -> provider-specific and supporting logic
 *
 */

console.log(">>> LOADED srv/copilot-service.js");

const cds = require("@sap/cds");
const pdfParse = require("pdf-parse");
const crypto = require("crypto");

// -----------------------------------------------------------------------------
// 1. Adapters
//    Small integration/supporting modules used by the workflow handlers.
// -----------------------------------------------------------------------------
const { extractReceiptFields } = require("./adapters/ai-extraction.js");
const { getFxRate } = require("./adapters/fx.js");
const { resolveNearbyAirports } = require("./adapters/airports.js");

// -----------------------------------------------------------------------------
// 2. Modular workflow handlers
//    Each major business step is implemented in its own handler module.
// -----------------------------------------------------------------------------
const registerExtractHandler = require("./handlers/extract.js");
const registerCostEfficiencyHandler = require("./handlers/cost-efficiency.js");
const registerCheaperOpportunitiesHandler = require("./handlers/cheaper-opportunities.js");
const registerMatchDmoHandler = require("./handlers/match-dmo.js");
const registerValidateHandler = require("./handlers/validate.js");
const registerConverFxHandler = require("./handlers/convert-fx.js");
const registerPostingProposalHandler = require("./handlers/posting-proposal.js");

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

module.exports = cds.service.impl(async function () {
  // ---------------------------------------------------------------------------
  // 3. CAP service context
  //    These are the entities exposed by copilot-service.cds.
  // ---------------------------------------------------------------------------
  const { Receipts, FxRates } = this.entities;

  // CAP query helpers
  const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

  if (!Receipts) {
    throw new Error(
      "Service entity 'Receipts' not found. Check srv/copilot-service.cds: " +
        "you must expose 'entity Receipts as projection on ...'"
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Technical / diagnostic actions
  //    Useful during development; not part of the main workflow story.
  // ---------------------------------------------------------------------------
  this.on("abapPing", async () => {
    try {
      const abap = await cds.connect.to("ABAP_CUSTOMER");
      const meta = await abap.get("/$metadata");
      return String(meta).slice(0, 200);
    } catch (e) {
      return `ERROR: ${e.message}`;
    }
  });

  console.log("===================");
  console.log("entity name:", Receipts.name);
  console.log("keys:", Object.keys(Receipts));
  console.log("elements:", Object.keys(Receipts.elements || {}));
  console.log("kind:", Receipts.kind);

  this.on("debugRequires", async () => {
    return Object.keys(cds.env.requires || {});
  });

  // ---------------------------------------------------------------------------
  // 5. Shared data-access helpers
  //    Reused by matching and cost-assessment handlers.
  // ---------------------------------------------------------------------------
  const normalizeTravelId = (value) => {
    const raw = String(value ?? "").trim();
    return raw && /^\d+$/.test(raw) ? String(Number(raw)) : null;
  };

  const loadTravelAndBookings = async (travelIdValue) => {
    const travelIdRaw = String(travelIdValue ?? "").trim();
    const travelIdNoZeros = normalizeTravelId(travelIdRaw);

    let travel = null;

    if (travelIdRaw) {
      travel = await SELECT.one
        .from("demo.copilot.Travels")
        .where({ TravelID: travelIdRaw });
    }

    if (!travel && travelIdNoZeros) {
      travel = await SELECT.one
        .from("demo.copilot.Travels")
        .where({ TravelID: travelIdNoZeros });
    }

    const bookings = travel
      ? await SELECT.from("demo.copilot.Bookings").where({
          TravelID: travel.TravelID,
        })
      : [];

    return {
      travelIdRaw,
      travelIdNoZeros,
      travel,
      bookings,
    };
  };

  const loadComparableFlightPrices = async (
    fromAirport,
    toAirport,
    flightDate
  ) => {
    if (!fromAirport || !toAirport || !flightDate) return [];

    const comparableConnections = await SELECT.from(
      "demo.copilot.Connections"
    ).where({
      AirportFromID: fromAirport,
      AirportToID: toAirport,
    });

    const prices = [];

    for (const conn of comparableConnections) {
      const flights = await SELECT.from("demo.copilot.Flights").where({
        CarrierID: conn.CarrierID,
        ConnectionID: conn.ConnectionID,
        FlightDate: flightDate,
      });

      for (const flight of flights) {
        const price = Number(flight?.Price);
        if (Number.isFinite(price) && price > 0) {
          prices.push(price);
        }
      }
    }

    return prices.sort((a, b) => a - b);
  };

  // ---------------------------------------------------------------------------
  // 6. Shared dependencies
  //    Handlers receive the same CAP APIs, entities and adapters explicitly.
  // ---------------------------------------------------------------------------
  const deps = {
    cds,
    SELECT,
    INSERT,
    UPDATE,

    entities: {
      Receipts,
      FxRates,
    },

    adapters: {
      extractReceiptFields,
      getFxRate,
      loadTravelAndBookings,
      loadComparableFlightPrices,
      resolveNearbyAirports,
    },
  };

  // ---------------------------------------------------------------------------
  // 7. Receipt ingestion
  //    Kept inline because upload is the entry point into the workflow.
  // ---------------------------------------------------------------------------
  this.on("uploadReceipt", async (req) => {
    const { fileName, mimeType, base64 } = req.data || {};

    if (!base64) req.reject(400, "base64 is required");
    if (!fileName) req.reject(400, "fileName is required");
    if (!mimeType) req.reject(400, "mimeType is required");

    let buf;

    try {
      const cleaned = base64.includes("base64,")
        ? base64.split("base64,").pop()
        : base64;

      buf = Buffer.from(cleaned, "base64");
    } catch (e) {
      req.reject(400, "Invalid base64 input");
    }

    const contentHash = crypto
      .createHash("sha256")
      .update(buf)
      .digest("hex");

    const existing = await SELECT.one.from(Receipts).where({ contentHash });

    if (existing) {
      return existing;
    }

    let parsed;

    try {
      parsed = await pdfParse(buf);
    } catch (e) {
      req.reject(400, `PDF parsing failed: ${e?.message || "unknown error"}`);
    }

    const ID = cds.utils.uuid();

    await INSERT.into(Receipts).entries({
      ID,
      fileName,
      mimeType,
      contentHash,
      extractedText: parsed.text,
      status: "NEW",
    });

    return SELECT.one.from(Receipts).where({ ID });
  });

  // ---------------------------------------------------------------------------
  // 8. Register modular workflow handlers
  //
  //    CopilotService action
  //          -> registered handler
  //          -> shared dependencies / adapters
  // ---------------------------------------------------------------------------
  registerExtractHandler(this, deps);
  registerCostEfficiencyHandler(this, deps);
  registerCheaperOpportunitiesHandler(this, deps);
  registerMatchDmoHandler(this, deps);
  registerValidateHandler(this, deps);
  registerConverFxHandler(this, deps);
  registerPostingProposalHandler(this, deps);

  // ---------------------------------------------------------------------------
  // 9. Corrected-data update
  // ---------------------------------------------------------------------------
  this.on("updateExtractedReceipt", async (req) => {
    const { receiptId, extractedJson } = req.data;

    if (!receiptId) {
      return req.reject(400, "Missing receiptId");
    }

    if (!extractedJson) {
      return req.reject(400, "Missing extractedJson");
    }

    let parsed;

    try {
      parsed =
        typeof extractedJson === "string"
          ? JSON.parse(extractedJson)
          : extractedJson;
    } catch (e) {
      return req.reject(400, "extractedJson is not valid JSON");
    }

    console.log("===========================================================");
    console.log("extractedJson === ", extractedJson);

    const jsonString = JSON.stringify(parsed);

    const updated = await UPDATE(Receipts)
      .set({
        extractedJson: jsonString,
        receiptDate: parsed.receiptDate || null,
        travelId: parsed.travelId || null,
        currency: parsed.currency || null,
        totalAmount: parsed.totalAmount || null,
      })
      .where({ ID: receiptId });

    if (updated === 0) {
      return req.reject(404, `Receipt not found: ${receiptId}`);
    }

    return {
      updated: true,
      receiptId,
    };
  });

  // ---------------------------------------------------------------------------
  // 10. Receipt lifecycle
  // ---------------------------------------------------------------------------
  this.on("deleteReceipt", async (req) => {
    const { receiptId } = req.data;

    if (!receiptId) {
      return req.reject(400, "Missing recieptId");
    }

    const tx = cds.tx(req);

    const deleted = await tx.run(
      DELETE.from(Receipts).where({ ID: receiptId })
    );

    if (deleted === 0) {
      return req.reject(404, `Receipt not found: ${receiptId}`);
    }

    return {
      deleted: true,
      receiptId,
    };
  });

  // ---------------------------------------------------------------------------
  // 11. Simple guidance action
  // ---------------------------------------------------------------------------
  this.on("chat", async () => {
    return "V1: Use extract/matchDMO/validate/convertFx/postingProposal actions.";
  });
});
