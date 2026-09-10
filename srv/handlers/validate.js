module.exports = function registerValidateHandler(service, deps) {
    const { SELECT, UPDATE, entities } = deps;
    const { Receipts } = entities;
  
    service.on("validate", async (req) => {
      const { receiptId } = req.data || {};
  
      if (!receiptId) {
        return req.reject(400, "receiptId is required");
      }
  
      // Load the receipt and validate the structured JSON produced by extraction.
      const r = await SELECT.one.from(Receipts).where({ ID: receiptId });
  
      if (!r) {
        return req.reject(404, "Receipt not found");
      }
  
      if (!r.extractedJson) {
        return req.reject(400, "Extract first");
      }
  
      let ex;
  
      try {
        ex = typeof r.extractedJson === "string" ? JSON.parse(r.extractedJson) : r.extractedJson;
      } catch (e) {
        return req.reject(400, "Extracted JSON is invalid");
      }
  
      const warnings = [];
      const missing = [];
  
      // Machine-readable validation details returned to the SAPUI5 Validation tab.
      const checks = {
        extracted: {},
        totals: {},
        flightLegs: [],
        items: []
      };
  
      // 1) Required receipt fields.
      if (!ex.documentType) missing.push("documentType");
      if (!ex.receiptNo) missing.push("receiptNo");
      if (!ex.receiptDate) missing.push("receiptDate");
      if (!ex.currency) missing.push("currency");
      if (ex.totalAmount == null) missing.push("totalAmount");
      if (!ex.travelId && !r.travelId) missing.push("travelId");
  
      checks.extracted.documentType = !!ex.documentType;
      checks.extracted.receiptNo = !!ex.receiptNo;
      checks.extracted.receiptDate = !!ex.receiptDate;
      checks.extracted.currency = !!ex.currency;
      checks.extracted.totalAmount = ex.totalAmount != null;
      checks.extracted.travelId = !!(ex.travelId || r.travelId);
      checks.extracted.supplier = !!ex.supplier;
  
      if (!ex.supplier) {
        warnings.push("Supplier missing. It is optional, but helpful.");
      }
  
      // 2) Basic format and value checks.
      if (ex.currency && !/^[A-Z]{3}$/.test(String(ex.currency).trim())) {
        warnings.push(`Currency "${ex.currency}" does not look like a valid ISO currency code.`);
      }
  
      if (ex.totalAmount != null && Number(ex.totalAmount) < 0) {
        warnings.push("Total amount is negative.");
      }
  
      if (ex.receiptDate && Number.isNaN(Date.parse(ex.receiptDate))) {
        warnings.push(`Receipt date "${ex.receiptDate}" is not a valid date.`);
      }

      // 3) Structured flight-leg checks.
      const docType = String(ex.documentType || "").toUpperCase();
      const flightLegs = Array.isArray(ex.flightLegs) ? ex.flightLegs : [];

      checks.extracted.hasFlightLegsArray = Array.isArray(ex.flightLegs);
      checks.extracted.flightLegCount = flightLegs.length;

      if (docType === "AIR") {
        if (ex.flightLegs != null && !Array.isArray(ex.flightLegs)) {
          warnings.push("flightLegs is present but is not an array.");
        }

        if (Array.isArray(ex.flightLegs) && flightLegs.length === 0) {
          warnings.push("AIR receipt has no flight legs.");
        }
      }

      flightLegs.forEach((leg, index) => {
        const legCheck = {
          index,
          leg: leg?.leg ?? null,
          carrierId: leg?.carrierId ?? null,
          flightNumber: leg?.flightNumber ?? null,
          route: leg?.route ?? null,
          fromAirport: leg?.fromAirport ?? null,
          toAirport: leg?.toAirport ?? null,
          flightDate: leg?.flightDate ?? null,
          farePerPassenger: leg?.farePerPassenger ?? null,
          currency: leg?.currency ?? null,
          ok: true,
          warnings: []
        };

        if (!leg.carrierId) {
          legCheck.ok = false;
          legCheck.warnings.push("Carrier ID is missing.");
        }

        if (!leg.flightNumber) {
          legCheck.ok = false;
          legCheck.warnings.push("Flight number is missing.");
        }

        if (!leg.route && (!leg.fromAirport || !leg.toAirport)) {
          legCheck.ok = false;
          legCheck.warnings.push("Route or from/to airports are missing.");
        }

        if (!leg.flightDate) {
          legCheck.ok = false;
          legCheck.warnings.push("Flight date is missing.");
        } else if (Number.isNaN(Date.parse(leg.flightDate))) {
          legCheck.ok = false;
          legCheck.warnings.push(`Flight date "${leg.flightDate}" is not valid.`);
        }

        if (leg.farePerPassenger != null && Number(leg.farePerPassenger) < 0) {
          legCheck.ok = false;
          legCheck.warnings.push("Fare per passenger is negative.");
        }

        if (!leg.currency) {
          legCheck.warnings.push("Flight leg currency is missing.");
        } else if (ex.currency && leg.currency !== ex.currency) {
          legCheck.warnings.push(
            `Flight leg currency ${leg.currency} differs from receipt currency ${ex.currency}.`
          );
        }

        if (legCheck.warnings.length > 0) {
          warnings.push(
            `Flight leg ${index + 1}: ${legCheck.warnings.join(" ")}`
          );
        }

        checks.flightLegs.push(legCheck);
      });

      // 4) Financial receipt-item checks.
      const items = Array.isArray(ex.items) ? ex.items : [];
  
      checks.extracted.hasItemsArray = Array.isArray(ex.items);
      checks.extracted.itemCount = items.length;
  
      if (!Array.isArray(ex.items)) {
        warnings.push("Items are missing or not an array.");
      }
  
      if (Array.isArray(ex.items) && items.length === 0) {
        warnings.push("No receipt items found.");
      }
  
      items.forEach((item, index) => {
        const itemCheck = {
          index,
          type: item?.type ?? null,
          description: item?.description ?? null,
          amount: item?.amount ?? null,
          currency: item?.currency ?? null,
          ok: true,
          warnings: []
        };
  
        if (!item.type) {
          itemCheck.ok = false;
          itemCheck.warnings.push("Item type is missing.");
        }
  
        if (!item.description) {
          itemCheck.warnings.push("Item description is missing.");
        }
  
        if (item.amount == null) {
          itemCheck.ok = false;
          itemCheck.warnings.push("Item amount is missing.");
        } else if (Number(item.amount) < 0) {
          itemCheck.ok = false;
          itemCheck.warnings.push("Item amount is negative.");
        }
  
        if (!item.currency) {
          itemCheck.warnings.push("Item currency is missing.");
        } else if (ex.currency && item.currency !== ex.currency) {
          itemCheck.warnings.push(
            `Item currency ${item.currency} differs from receipt currency ${ex.currency}.`
          );
        }
  
        const docType = String(ex.documentType || "").toUpperCase();
        const itemType = String(item.type || "").toLowerCase();
  
        if (docType === "AIR" && itemType === "airfare") {
          const hasFlightSpecificInfo =
            item.carrierId || item.flightNumber || item.flightDate || item.bookingId;

          if (hasFlightSpecificInfo) {
            if (item.flightDate && Number.isNaN(Date.parse(item.flightDate))) {
              itemCheck.warnings.push(`Airfare item flightDate "${item.flightDate}" is not valid.`);
            }

            if (item.flightNumber && !/^\d+$/.test(String(item.flightNumber))) {
              itemCheck.warnings.push("Airfare item flightNumber should contain digits only.");
            }
          }
        }
  
        if (itemCheck.warnings.length > 0) {
          warnings.push(
            `Item ${index + 1}: ${itemCheck.warnings.join(" ")}`
          );
        }
  
        checks.items.push(itemCheck);
      });
  
      // 5) Reconcile the item sum with the extracted receipt total.
      if (items.length > 0 && ex.totalAmount != null) {
        const sum = items.reduce(
          (acc, item) => acc + (Number(item.amount) || 0),
          0
        );
  
        const extractedTotal = Number(ex.totalAmount);
        const diff = Math.abs(sum - extractedTotal);
  
        checks.totals.extractedItemSum = Number(sum.toFixed(2));
        checks.totals.extractedTotal = extractedTotal;
        checks.totals.extractedDiff = Number(diff.toFixed(2));
        checks.totals.itemSumMatchesTotal = diff <= 0.5;
  
        if (diff > 0.5) {
          warnings.push(
            `Item sum (${sum.toFixed(2)}) differs from extracted total (${extractedTotal.toFixed(2)}).`
          );
        }
      }
  
      // 6) Deterministic severity: missing required fields -> FAIL; other issues -> WARN; otherwise OK.
      const severity =
        missing.length > 0
          ? "FAIL"
          : warnings.length > 0
            ? "WARN"
            : "OK";
  
      // Validation severity and workflow status are intentionally separate concepts.
      const out = {
        ok: severity !== "FAIL",
        severity,
        missing,
        warnings,
        checks,
        summary: {
          receiptId,
          travelId: ex.travelId ?? r.travelId ?? null,
          documentType: ex.documentType ?? null,
          receiptNo: ex.receiptNo ?? null,
          receiptDate: ex.receiptDate ?? null,
          currency: ex.currency ?? null,
          totalAmount: ex.totalAmount ?? null,
          itemCount: items.length,
          statusBefore: r.status,
          statusAfter: "VALIDATED"
        }
      };
  
      // Persist that the validation step has been executed.
      if (r.status !== "VALIDATED") {
        await UPDATE(Receipts)
          .set({ status: "VALIDATED" })
          .where({ ID: receiptId });
      }

      console.log("Validation result for receipt ID", receiptId, ":", JSON.stringify(out, null, 2));
  
      return JSON.stringify(out, null, 2);
    });
  };
