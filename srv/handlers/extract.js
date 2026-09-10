/**
 * Intelligent Extraction — CAP workflow handler
 *
 * Flow:
 *   stored extractedText
 *        -> reuse existing structured result when possible
 *        -> otherwise call the configured AI extraction adapter
 *        -> persist structured fields
 *        -> status = "EXTRACTED"
 */

module.exports = function registerExtractHandler(service, deps) {

  // ---------------------------------------------------------------------------
  // 1. Shared CAP dependencies
  // ---------------------------------------------------------------------------
  const { SELECT, UPDATE, entities, adapters } = deps;

  const { Receipts } = entities;
  const { extractReceiptFields } = adapters;

  // ---------------------------------------------------------------------------
  // 2. Map structured AI JSON to persisted receipt fields
  // ---------------------------------------------------------------------------
  const parseExtracted = (jsonText) => {
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  };

  const buildExtractedFields = (jsonText) => {
    const parsed = parseExtracted(jsonText);

    return {
      extractedJson: jsonText,
      travelId: parsed?.travelId ?? null,
      currency: parsed?.currency ?? null,
      totalAmount: parsed?.totalAmount ?? null,
      receiptDate: parsed?.receiptDate ?? null,
      status: "EXTRACTED"
    };
  };

  // ---------------------------------------------------------------------------
  // 3. CAP OData action: extract
  //    The handler works with the text already stored during PDF ingestion.
  // ---------------------------------------------------------------------------
  service.on("extract", async (req) => {
    const { receiptId } = req.data || {};

    if (!receiptId) {
      return req.reject(400, "receiptId is required");
    }

    console.log(`[extract] START receiptId=${receiptId}`);

    const r = await SELECT.one
      .from(Receipts)
      .where({ ID: receiptId });

    if (!r) {
      return req.reject(404, "Receipt not found");
    }

    if (!r.extractedText) {
      return req.reject(
        400,
        "No extractedText available. Upload PDF first."
      );
    }

    // -------------------------------------------------------------------------
    // 4. Reuse the current receipt when structured extraction already exists
    // -------------------------------------------------------------------------
    if (r.extractedJson) {
      console.log(`[extract] REUSE_CURRENT receiptId=${receiptId}`);

      const currentFields = buildExtractedFields(r.extractedJson);

      await UPDATE(Receipts)
        .set(currentFields)
        .where({ ID: receiptId });

      return SELECT.one
        .from(Receipts)
        .where({ ID: receiptId });
    }

    let existing = null;

    // -------------------------------------------------------------------------
    // 5. Reuse another extraction with the same content fingerprint
    //
    //    contentHash is used instead of extractedText because extractedText
    //    is a LargeString / NCLOB in HANA.
    // -------------------------------------------------------------------------
    if (r.contentHash) {
      existing = await SELECT.one
        .from(Receipts)
        .where({
          contentHash: r.contentHash,
          extractedJson: { "!=": null },
          ID: { "!=": receiptId }
        });

      if (existing?.ID) {
        console.log(
          `[extract] REUSE_BY_CONTENT_HASH ` +
          `sourceReceiptId=${existing.ID} targetReceiptId=${receiptId}`
        );
      }
    }

    if (existing?.extractedJson) {
      const reusedFields = buildExtractedFields(existing.extractedJson);

      await UPDATE(Receipts)
        .set(reusedFields)
        .where({ ID: receiptId });

      return SELECT.one
        .from(Receipts)
        .where({ ID: receiptId });
    }

    // -------------------------------------------------------------------------
    // 6. AI extraction
    //    Only call the configured adapter when no reusable result exists.
    //    The adapter receives stored text — not the complete PDF.
    // -------------------------------------------------------------------------
    console.log(`[extract] OPENAI_CALL receiptId=${receiptId}`);

    const jsonText = await extractReceiptFields(r.extractedText);
    const extractedFields = buildExtractedFields(jsonText);

    console.log("===========================================================");
    console.log(
      `[extract] EXTRACTED receiptId=${receiptId}`,
      extractedFields
    );

    // -------------------------------------------------------------------------
    // 7. Persist the structured result and status = EXTRACTED
    // -------------------------------------------------------------------------
    await UPDATE(Receipts)
      .set(extractedFields)
      .where({ ID: receiptId });

    return SELECT.one
      .from(Receipts)
      .where({ ID: receiptId });
  });
};
