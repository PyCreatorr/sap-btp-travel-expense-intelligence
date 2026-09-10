module.exports = function registerPostingProposalHandler(service, deps) {
  const { SELECT, entities } = deps;
  const { Receipts } = entities;

  // 1) Financial helpers: classify extracted items and prepare draft accounting suggestions.
  const round2 = (value) => Number((Number(value || 0)).toFixed(2));

  const isAirfareLine = (item) =>
    String(item?.type || "").trim().toLowerCase() === "airfare";

  const asArray = (value) => (Array.isArray(value) ? value : []);

  // Suggested account keys are placeholders for a future ERP / G/L mapping, not real postings.
  const getPostingSuggestion = (lineCategory, item) => {
    if (lineCategory === "AIRFARE") {
      return {
        suggestedCategory: "Travel airfare expense",
        suggestedAccount: "TRAVEL_AIRFARE_EXPENSE",
        reason: "Item type is Airfare, so it is proposed as airfare travel cost."
      };
    }

    const type = String(item?.type || "").trim().toLowerCase();

    if (type === "fee") {
      return {
        suggestedCategory: "Travel agency / service fee",
        suggestedAccount: "TRAVEL_SERVICE_FEE",
        reason: "Item type is Fee, so it is proposed as non-airfare service cost."
      };
    }

    if (type === "tax" || type === "taxes") {
      return {
        suggestedCategory: "Travel taxes and charges",
        suggestedAccount: "TRAVEL_TAXES",
        reason: "Item type is tax-related, so it is proposed as travel taxes/charges."
      };
    }

    return {
      suggestedCategory: "Other travel expense",
      suggestedAccount: "TRAVEL_OTHER_EXPENSE",
      reason: "Item is not Airfare, Fee, or Taxes, so it is proposed as other travel expense."
    };
  };

  // 2) Main action: build a posting proposal only. No FI document or ERP posting is created here.
  service.on("postingProposal", async (req) => {
      const { receiptId, postingCurrency } = req.data || {};
  
      if (!receiptId) return req.reject(400, "receiptId is required");
      if (!postingCurrency) return req.reject(400, "postingCurrency is required");
  
      // Load the stored receipt and its structured extraction result.
      const r = await SELECT.one.from(Receipts).where({ ID: receiptId });
      if (!r) return req.reject(404, "Receipt not found");
      if (!r.extractedJson) return req.reject(400, "Extract first");

        // Reuse the central FX action so conversion follows the receipt-date FX flow and cache handling.
        const fxObj = await service.send("convertFx", {
        receiptId,
        toCurrency: postingCurrency
        });
    
        let ex;
        try {
        ex = JSON.parse(r.extractedJson);
        } catch {
        ex = {};
        }

        // Posting lines come from extracted financial items; customers and flight legs remain context only.
        const items = asArray(ex.items);

        const customers = asArray(ex.customers);

        const flightLegs = asArray(ex.flightLegs);

        const rate = Number(fxObj?.rate ?? 1);

        const currencyOriginal = ex.currency ?? r.currency ?? null;

        const headerTotalOriginal = Number(ex.totalAmount ?? r.totalAmount ?? 0);

        // 3) One extracted financial item becomes one draft posting line.
        const proposalLines = items.map((item, index) => {
          // Preserve the original amount and derive the posting-currency amount using the resolved FX rate.
          const amountOriginal = Number(item?.amount || 0);
          const amountPosting = round2(amountOriginal * rate);
          // Separate airfare from other travel costs for downstream accounting treatment.
          const lineCategory = isAirfareLine(item) ? "AIRFARE" : "NON_AIRFARE";
          const postingSuggestion = getPostingSuggestion(lineCategory, item);
    
          return {
            lineNo: index + 1,
    
            lineCategory,
    
            amountOriginal: round2(amountOriginal),
    
            amountPosting,
    
            postingCurrency,
    
            postingSuggestion,
    
            // Keep the original extracted item fields for traceability.
            ...item
          };
        });
    
    // 4) Calculate airfare / non-airfare subtotals in original and posting currency.
    const airfareOriginal = round2(
      proposalLines
        .filter((line) => line.lineCategory === "AIRFARE")
        .reduce((sum, line) => sum + Number(line.amountOriginal || 0), 0)
    );
    
    const nonAirfareOriginal = round2(
      proposalLines
        .filter((line) => line.lineCategory === "NON_AIRFARE")
        .reduce((sum, line) => sum + Number(line.amountOriginal || 0), 0)
    );
    
    const airfarePosting = round2(
      proposalLines
        .filter((line) => line.lineCategory === "AIRFARE")
        .reduce((sum, line) => sum + Number(line.amountPosting || 0), 0)
    );
    
    const nonAirfarePosting = round2(
      proposalLines
        .filter((line) => line.lineCategory === "NON_AIRFARE")
        .reduce((sum, line) => sum + Number(line.amountPosting || 0), 0)
    );
    
    const lineSumOriginal = round2(
      proposalLines.reduce((sum, line) => sum + Number(line.amountOriginal || 0), 0)
    );

    const lineSumPosting = round2(
      proposalLines.reduce((sum, line) => sum + Number(line.amountPosting || 0), 0)
    );
    
    const totalOriginal = round2(headerTotalOriginal || lineSumOriginal);

    const totalPosting = fxObj?.converted != null ? round2(fxObj.converted) : lineSumPosting;

    // Reconcile proposal-line sums with the receipt/header totals.
    const totalDifferenceOriginal = round2(totalOriginal - lineSumOriginal);
    const totalDifferencePosting = round2(totalPosting - lineSumPosting);

    const customerCount = Number(ex.customerCount || customers.length || 0);
    const flightLegCount = flightLegs.length;
    const farePerCustomerPerLeg =
      airfareOriginal > 0 && customerCount > 0 && flightLegCount > 0
        ? round2(airfareOriginal / customerCount / flightLegCount)
        : null;

    // Itinerary and customer data stay informational; they do not create extra posting lines.
    const documentContext = {
      documentType: ex.documentType ?? null,

      customerCount,

      flightLegCount,

      farePerCustomerPerLeg,

      postingLineStrategy:
        "Posting lines stay financial. Airfare is not split into passenger/leg lines unless accounting explicitly requires it."
    };

    const postingSuggestions = {
      AIRFARE: {
        suggestedCategory: "Travel airfare expense",
        suggestedAccount: "TRAVEL_AIRFARE_EXPENSE",
        description: "Use for flight fare cost from receipt items with type Airfare."
      },
      NON_AIRFARE: {
        suggestedCategory: "Travel non-airfare expense",
        suggestedAccount: "TRAVEL_OTHER_EXPENSE",
        description: "Use for fees, taxes, service charges, taxi, hotel, or other non-airfare costs."
      }
    };

    // 5) Return a UI-ready draft with original/converted totals, suggestions, line details and FX metadata.
    const result = {
      receiptNo: ex.receiptNo ?? null,
      receiptDate: ex.receiptDate ?? null,
      travelId: ex.travelId ?? r.travelId ?? null,
      supplier: ex.supplier ?? null,
      currencyOriginal,
      totalOriginal,
      airfareOriginal,
      nonAirfareOriginal,
      postingCurrency,
      totalPosting,
      airfarePosting,
      nonAirfarePosting,
      lineSumOriginal,
      lineSumPosting,
      totalDifferenceOriginal,
      totalDifferencePosting,
      totalScope: "FULL_RECEIPT",
      linesIncludeNonAirfare: proposalLines.some(
        (line) => line.lineCategory === "NON_AIRFARE"
      ),
      documentContext,
      postingSuggestions,
      lines: proposalLines,
      fx: fxObj
    };

    console.log("POSTING PROPOSAL =", JSON.stringify(result, null, 2));
    console.log("================================");
    
    return result;
  });
};
