sap.ui.define([
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "demo/copilot/receiptworkbench/controller/Workbench.controller",
    "demo/copilot/receiptworkbench/service/CopilotApi",
], function(MessageBox, MessageToast,  _pretty, CopilotApi ){ "use strict"; 
  
  // ======================================================
  // Private pure helper functions
  // ======================================================


function round2(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
  }

  function toPriceNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function makeFlightKey(item) {
    return [
      item && item.carrierId || "",
      item && item.connectionId || "",
      item && item.flightDate || "",
      item && item.routeFrom || "",
      item && item.routeTo || "",
      round2(item && item.price)
    ].join("::");
  }

  function createDisplayFlight(item, role, fallbackCurrency) {
    if (!item) return null;
    const price = toPriceNumber(item.price);
    const carrier = item.carrierId || "";
    const connection = item.connectionId || "";
    const date = item.flightDate || "";
    const route = [item.routeFrom, item.routeTo].filter(Boolean).join(" → ");
    const compactId = [carrier, connection].filter(Boolean).join(" ");
    return {
      carrierId: carrier,
      connectionId: connection,
      flightDate: date,
      routeFrom: item.routeFrom || "",
      routeTo: item.routeTo || "",
      price: round2(price),
      currency: item.currency || fallbackCurrency || "",
      scope: item.scope || "",
      role: role || "",
      roleText: role || "",
      roleCategory: "Other",
      displayTitle: compactId || (role || "Option"),
      detailText: [date, route].filter(Boolean).join(" · "),
      chartLabel: [compactId || carrier || "Flight", date].filter(Boolean).join(" "),
      shortLabel: compactId || carrier || "Flight",
      displayValue: price == null ? "" : String(round2(price)),
      color: "Neutral"
    };
  }

  function pickClosestByPrice(items, targetPrice, excludedKeys) {
    const target = toPriceNumber(targetPrice);
    if (!Array.isArray(items) || target == null) return null;
    const excluded = excludedKeys || new Set();
    let best = null;
    let bestDiff = Infinity;

    items.forEach(function (item) {
      const price = toPriceNumber(item && item.price);
      if (price == null) return;
      const key = makeFlightKey(item);
      if (excluded.has(key)) return;
      const diff = Math.abs(price - target);
      if (diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    });

    return best;
  }

  function sortByPrice(items) {
    return (Array.isArray(items) ? items.slice() : []).sort(function (a, b) {
      const pa = toPriceNumber(a && a.price);
      const pb = toPriceNumber(b && b.price);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });
  }

  function mapStatusState(status) {
    switch (status) {
      case "GOOD": return "Success";
      case "VERIFIED": return "Success";
      case "FULL": return "Success";
      case "ACCEPTABLE": return "Information";
      case "REVIEW": return "Warning";
      case "PARTIAL_ONLY": return "Warning";
      case "INSUFFICIENT_DATA": return "Warning";
      case "SUSPICIOUS": return "Error";
      case "NOT_ASSESSABLE": return "Error";
      case "MATERIAL_OPPORTUNITY": return "Warning";
      case "POTENTIAL_ONLY": return "Information";
      case "SMALL_DIFFERENCE": return "Information";
      case "NO_MATERIAL_OPPORTUNITY": return "Success";
      case "NO_NET_SAVING": return "Success";
      case "NO_NEARBY_AIRPORTS": return "Warning";
      case "NO_ALTERNATIVES": return "Warning";
      case "UNVERIFIED": return "Warning";
      default: return "None";
    }
  }

  function buildGraphPoints(alternatives, selectedPrice, benchmarkPrice, cheapestPrice, referencePrice) {
    return sortByPrice(alternatives).map(function (item, index) {
      const display = createDisplayFlight(item, "", item.currency || "");
      const seq = index + 1;
      const shortFlight = [display.carrierId, display.connectionId].filter(Boolean).join(" ");
      return {
        flightOrder: seq,
        flight: shortFlight ? seq + ". " + shortFlight : String(seq),
        flightFull: [display.displayTitle, display.detailText].filter(Boolean).join(" · "),
        price: round2(display.price),
        selectedLine: round2(selectedPrice),
        benchmarkLine: round2(benchmarkPrice),
        cheapestLine: round2(cheapestPrice),
        referenceLine: round2(referencePrice)
      };
    });
  }

  function buildGraphVizProperties(graphPoints) {
    const values = (Array.isArray(graphPoints) ? graphPoints : [])
      .flatMap(function (p) {
        return [p && p.price, p && p.selectedLine, p && p.benchmarkLine, p && p.cheapestLine, p && p.referenceLine];
      })
      .map(function (v) { return Number(v); })
      .filter(function (v) { return Number.isFinite(v); });

    const minValue = values.length ? Math.min.apply(null, values) : 0;
    const maxValue = values.length ? Math.max.apply(null, values) : 100;
    const spread = Math.max(maxValue - minValue, Math.max(maxValue, 1) * 0.1, 10);
    const lowerPadding = spread * 0.12;
    const upperPadding = spread * 0.18;
    const axisMin = Math.max(0, round2(minValue - lowerPadding));
    const axisMax = round2(maxValue + upperPadding);

    return {
      legend: { visible: true },
      title: { visible: false },
      valueAxis: {
        title: { visible: true, text: "Price" },
        scale: {
          fixedRange: true,
          minValue: axisMin,
          maxValue: axisMax
        }
      },
      categoryAxis: {
        title: { visible: true, text: "Flights" }
      },
      plotArea: {
        dataLabel: { visible: false }
      }
    };
  }


  function formatAmount(value, currency) {
    const num = round2(value);
    return (num == null ? "-" : String(num)) + (currency ? " " + currency : "");
  }

  function prepareUnmatchedReceiptLeg(leg) {
    leg = leg || {};
    const route = leg.route || [leg.fromAirport, leg.toAirport].filter(Boolean).join(" → ");
    const flight = [leg.carrierId, leg.flightNumber].filter(Boolean).join(" ");
    return Object.assign({}, leg, {
      legTitle: "Leg " + (leg.leg || "?") + (route ? " · " + route : ""),
      legDetailText: [flight, leg.flightDate].filter(Boolean).join(" · "),
      estimatedAirfareText: formatAmount(leg.estimatedReceiptAirfareSource, leg.currency || leg.sourceCurrency),
      reasonText: leg.reason || "No matching DMO booking was found for this extracted receipt flight leg."
    });
  }

  function prepareCostLine(line, displayCurrency, index) {
    line = line || {};
    const allAlternativeSource = sortByPrice(line.allAlternatives || line.alternatives || []);

    // IMPORTANT:
    // - For a grouped leg card, totals are shown in the cards/table.
    // - The chart must use per-passenger prices, because the benchmark alternatives are per flight/per passenger.
    const selectedChartPrice = round2(
      line.selectedPricePerPassenger != null ? line.selectedPricePerPassenger : line.selectedPrice
    );
    const benchmarkChartPrice = round2(
      line.benchmarkPricePerPassenger != null ? line.benchmarkPricePerPassenger : line.benchmarkPrice
    );
    const referenceChartPrice = round2(
      line.benchmarkMedianPricePerPassenger != null ? line.benchmarkMedianPricePerPassenger : line.benchmarkMedianPrice
    );

    const currency = line.decisionCurrency || displayCurrency || line.currency || "";
    const sourceCurrency = line.sourceCurrency || line.bookingCurrency || "";

    const benchmarkAlt = createDisplayFlight(
      line.benchmarkAlternative ? line.benchmarkAlternative : pickClosestByPrice(allAlternativeSource, benchmarkChartPrice, new Set()),
      "Benchmark Alternative",
      currency
    );

    const cheapestAlt = createDisplayFlight(
      line.cheapestAlternative ? line.cheapestAlternative : (allAlternativeSource[0] || null),
      "Cheapest Alternative",
      currency
    );

    const referenceAlt = createDisplayFlight(
      line.referenceAlternative ? line.referenceAlternative : pickClosestByPrice(allAlternativeSource, referenceChartPrice, new Set()),
      "Reference Alternative",
      currency
    );

    const selectedFlight = createDisplayFlight({
      carrierId: line.carrierId,
      connectionId: line.connectionId,
      flightDate: line.flightDate,
      routeFrom: line.routeFrom,
      routeTo: line.routeTo,
      price: selectedChartPrice,
      currency: currency,
      scope: "SELECTED"
    }, "Selected Flight", currency);

    const allAlternatives = allAlternativeSource.map(function (item) {
      const display = createDisplayFlight(item, "Comparable Flight", currency);
      const itemKey = makeFlightKey(item);
      const roles = [];
      if (benchmarkAlt && itemKey === makeFlightKey(benchmarkAlt)) roles.push("Benchmark Alternative");
      if (cheapestAlt && itemKey === makeFlightKey(cheapestAlt)) roles.push("Cheapest Alternative");
      if (referenceAlt && itemKey === makeFlightKey(referenceAlt)) roles.push("Reference Alternative");
      display.roleText = roles.length ? roles.join(" • ") : "Comparable Flight";
      return display;
    });

    const graphPoints = buildGraphPoints(
      allAlternatives,
      selectedChartPrice,
      benchmarkAlt && benchmarkAlt.price,
      cheapestAlt && cheapestAlt.price,
      referenceAlt && referenceAlt.price
    );

    const passengerCount = Number(line.passengerCount || line.bookingCount || 1);
    const selectedTotal = round2(line.selectedTotal != null ? line.selectedTotal : line.selectedPrice);
    const benchmarkTotal = round2(line.benchmarkTotal != null ? line.benchmarkTotal : line.benchmarkPrice);
    const selectedTotalSource = round2(line.selectedTotalSource != null ? line.selectedTotalSource : line.selectedPriceSource);
    const benchmarkTotalSource = round2(line.benchmarkTotalSource != null ? line.benchmarkTotalSource : line.benchmarkPriceSource);

    const routeText = [line.routeFrom, line.routeTo].filter(Boolean).join(" → ");
    const title = line.lineTitle || ("Leg " + (index + 1) + (routeText ? " · " + routeText : ""));
    const subtitle = line.lineSubtitle || [
      line.flightDate,
      line.carrierId,
      passengerCount + " passenger booking" + (passengerCount === 1 ? "" : "s"),
      line.benchmarkMode
    ].filter(Boolean).join(" · ");

    return Object.assign({}, line, {
      lineTitle: title,
      lineSubtitle: subtitle,
      statusState: mapStatusState(line.status || line.decisionStatus),
      sourceStatusState: mapStatusState(line.sourceStatus),
      decisionStatusState: mapStatusState(line.decisionStatus || line.status),
      selectedFlight: selectedFlight,
      benchmarkAlternative: benchmarkAlt,
      cheapestAlternative: cheapestAlt,
      referenceAlternative: referenceAlt,
      graphPoints: graphPoints,
      graphVizProperties: buildGraphVizProperties(graphPoints),
      legKey: line.legKey || line.lineId || ("leg-" + (index + 1)),
      legTabText: line.legTabText || ("Leg " + (index + 1)),
      graphTitle: "Price graph per passenger (" + graphPoints.length + " alternatives)",
      graphHelpText: "Chart uses per-passenger prices in " + currency + ". The totals above show the grouped leg totals for all passengers.",
      allAlternatives: allAlternatives,
      passengerSummary: passengerCount + " passenger booking" + (passengerCount === 1 ? "" : "s"),
      selectedTotalDisplay: selectedTotal,
      benchmarkTotalDisplay: benchmarkTotal,
      selectedTotalSourceDisplay: selectedTotalSource,
      benchmarkTotalSourceDisplay: benchmarkTotalSource,
      decisionTotalsText: "Selected " + (selectedTotal == null ? "-" : selectedTotal) + " " + currency + " · Benchmark " + (benchmarkTotal == null ? "-" : benchmarkTotal) + " " + currency,
      sourceTotalsText: sourceCurrency ? "Source " + (selectedTotalSource == null ? "-" : selectedTotalSource) + " " + sourceCurrency + " · Benchmark " + (benchmarkTotalSource == null ? "-" : benchmarkTotalSource) + " " + sourceCurrency : "",
      benchmarkMetaText: [line.benchmarkStrength, line.benchmarkMode, line.comparableCount != null ? String(line.comparableCount) + " comparable flights" : ""].filter(Boolean).join(" · ")
    });
  }

  function prepareCostResult(result) {
    if (!result) return result;

    const decisionCurrency = result.decisionCurrency || result.bookingCurrency || "";
    const sourceCurrency = result.sourceCurrency || result.bookingCurrency || "";
    const sourceLines = Array.isArray(result.lines) ? result.lines : [];
    const sourceLegGroups = Array.isArray(result.legGroups) ? result.legGroups : [];

    const preparedLines = sourceLines.map(function (line, index) {
      return prepareCostLine(line, decisionCurrency, index);
    });

    const preparedLegGroups = sourceLegGroups.map(function (group, index) {
      return prepareCostLine(Object.assign({}, group, {
        // Keep grouped totals on the group itself, but feed per-passenger values into the chart.
        selectedPrice: group.selectedPricePerPassenger != null ? group.selectedPricePerPassenger : group.selectedTotal,
        benchmarkPrice: group.benchmarkPricePerPassenger != null ? group.benchmarkPricePerPassenger : group.benchmarkTotal,
        benchmarkMedianPrice: group.benchmarkMedianPricePerPassenger != null ? group.benchmarkMedianPricePerPassenger : group.benchmarkMedianTotal,
        selectedPriceSource: group.selectedPricePerPassengerSource != null ? group.selectedPricePerPassengerSource : group.selectedTotalSource,
        benchmarkPriceSource: group.benchmarkPricePerPassengerSource != null ? group.benchmarkPricePerPassengerSource : group.benchmarkTotalSource,
        benchmarkMedianPriceSource: group.benchmarkMedianPricePerPassengerSource != null ? group.benchmarkMedianPricePerPassengerSource : group.benchmarkMedianTotalSource
      }), decisionCurrency, index);
    });

    const decision = result.decisionCurrencyDecision || {
      currency: decisionCurrency,
      selectedTotal: result.selectedTotal,
      benchmarkTotal: result.benchmarkTotal,
      status: result.overallStatus,
      difference: result.selectedTotal != null && result.benchmarkTotal != null ? round2(Number(result.selectedTotal) - Number(result.benchmarkTotal)) : null,
      differencePercent: result.benchmarkTotal > 0 ? round2(((Number(result.selectedTotal) - Number(result.benchmarkTotal)) / Number(result.benchmarkTotal)) * 100) : null
    };

    const source = result.sourceCurrencyDecision || {
      currency: sourceCurrency,
      selectedTotal: result.selectedTotalSource,
      benchmarkTotal: result.benchmarkTotalSource,
      status: result.sourceOverallStatus
    };

    const fx = result.currencyContext || {};
    const integrity = result.receiptIntegrity || {};
    const integrityStatus = result.integrityStatus || integrity.status || "UNKNOWN";
    const costAssessmentStatus = result.costAssessmentStatus || integrity.costAssessmentStatus || "FULL";
    const unmatchedReceiptFlightLegs = (integrity.unmatchedReceiptFlightLegs || result.unmatchedReceiptFlightLegs || []).map(prepareUnmatchedReceiptLeg);
    const partialOnly = integrityStatus === "SUSPICIOUS" || costAssessmentStatus === "PARTIAL_ONLY" || costAssessmentStatus === "NOT_ASSESSABLE";
    const assessedAirfareSource = result.assessedAirfareSource != null ? result.assessedAirfareSource : integrity.assessedAirfareSource;
    const unassessedAirfareSource = result.unassessedAirfareSource != null ? result.unassessedAirfareSource : integrity.unassessedAirfareSource;
    const sourceCurrencyForIntegrity = integrity.sourceCurrency || sourceCurrency;

    return Object.assign({}, result, {
      lines: preparedLines,
      legGroups: preparedLegGroups,
      activeLegKey: preparedLegGroups[0] ? preparedLegGroups[0].legKey : "",
      activeLegGroup: preparedLegGroups[0] || null,
      overallStatusState: mapStatusState(result.overallStatus),
      sourceOverallStatusState: mapStatusState(result.sourceOverallStatus),
      decisionCurrencyDecision: decision,
      sourceCurrencyDecision: source,
      integrityStatus: integrityStatus,
      integrityStatusState: mapStatusState(integrityStatus),
      costAssessmentStatus: costAssessmentStatus,
      costAssessmentStatusState: mapStatusState(costAssessmentStatus),
      integrityVisible: integrityStatus !== "VERIFIED" && integrityStatus !== "UNKNOWN" || partialOnly,
      partialOnlyVisible: partialOnly,
      integrityMessage: result.integrityMessage || integrity.message || "",
      integrityWarnings: result.integrityWarnings || integrity.warnings || [],
      unmatchedReceiptFlightLegs: unmatchedReceiptFlightLegs,
      unmatchedReceiptFlightLegCount: unmatchedReceiptFlightLegs.length,
      matchedReceiptFlightLegCount: integrity.matchedReceiptFlightLegCount || (result.matchedReceiptFlightLegs || []).length || 0,
      receiptFlightLegCount: integrity.receiptFlightLegCount || ((result.matchedReceiptFlightLegs || []).length + unmatchedReceiptFlightLegs.length),
      assessedAirfareText: "Assessed airfare " + formatAmount(assessedAirfareSource, sourceCurrencyForIntegrity),
      unassessedAirfareText: "Unassessed / suspicious airfare " + formatAmount(unassessedAirfareSource, sourceCurrencyForIntegrity),
      partialBenchmarkSummaryText: partialOnly ? "Partial benchmark only: the numbers below cover matched DMO legs, not the full receipt." : "Full benchmark: all extracted receipt flight legs were matched.",
      partialDecisionSummaryText: result.partialDecisionCurrencyDecision
        ? "Matched-leg benchmark " + formatAmount(result.partialDecisionCurrencyDecision.selectedTotal, result.partialDecisionCurrencyDecision.currency || decisionCurrency) + " · Benchmark " + formatAmount(result.partialDecisionCurrencyDecision.benchmarkTotal, result.partialDecisionCurrencyDecision.currency || decisionCurrency) + " · " + result.partialDecisionCurrencyDecision.status
        : "",
      decisionSummaryText: (partialOnly ? "Partial assessed airfare " : "Selected airfare ") + (decision.selectedTotal == null ? "-" : decision.selectedTotal) + " " + (decision.currency || decisionCurrency) + " · Benchmark " + (decision.benchmarkTotal == null ? "-" : decision.benchmarkTotal) + " " + (decision.currency || decisionCurrency),
      sourceSummaryText: "Selected airfare " + (source.selectedTotal == null ? "-" : source.selectedTotal) + " " + (source.currency || sourceCurrency) + " · Benchmark " + (source.benchmarkTotal == null ? "-" : source.benchmarkTotal) + " " + (source.currency || sourceCurrency),
      fullReceiptSummaryText: "Full receipt " + (result.fullReceiptTotal == null ? "-" : result.fullReceiptTotal) + " " + decisionCurrency + " · Non-airfare " + (result.nonAirfareTotal == null ? "-" : result.nonAirfareTotal) + " " + decisionCurrency,
      fxSummaryText: "FX date " + (fx.fxRateDate || "-") + " · Rate " + (fx.fxRate == null ? "-" : fx.fxRate),
      benchmarkSummaryText: [result.benchmarkStrength ? "Strength " + result.benchmarkStrength : "", result.benchmarkMode ? "Mode " + result.benchmarkMode : ""].filter(Boolean).join(" · ")
    });
  }

  function formatCoordinate(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(5) : "-";
  }

  function opportunityMessageType(status) {
    switch (status) {
      case "MATERIAL_OPPORTUNITY": return "Warning";
      case "POTENTIAL_ONLY": return "Information";
      case "NO_MATERIAL_OPPORTUNITY": return "Success";
      default: return "Information";
    }
  }

  function prepareOpportunityAlternative(alternative, fallbackCurrency) {
    if (!alternative) return null;

    const routeText = [alternative.routeFrom, alternative.routeTo].filter(Boolean).join(" → ");
    const flightText = [alternative.carrierId, alternative.connectionId].filter(Boolean).join(" ");
    const changed = [];
    if (alternative.originChanged) {
      changed.push("origin " + (alternative.originDistanceKm == null ? "" : alternative.originDistanceKm + " km"));
    }
    if (alternative.destinationChanged) {
      changed.push("destination " + (alternative.destinationDistanceKm == null ? "" : alternative.destinationDistanceKm + " km"));
    }

    return Object.assign({}, alternative, {
      routeText: routeText,
      flightText: flightText,
      titleText: [flightText, routeText].filter(Boolean).join(" · "),
      changedAirportText: changed.length ? changed.join(" · ") : "No airport change",
      pricePerPassengerDisplay: round2(alternative.pricePerPassenger),
      flightTotalDisplay: round2(alternative.flightTotal),
      adjustedTotalDisplay: round2(alternative.adjustedTotal),
      grossSavingDisplay: round2(alternative.grossSaving),
      netSavingDisplay: round2(alternative.netSaving),
      netSavingPercentDisplay: round2(alternative.netSavingPercent),
      currency: alternative.decisionCurrency || fallbackCurrency || "",
      dateText: alternative.dateOffsetDays
        ? alternative.flightDate + " (±" + alternative.dateOffsetDays + " day" + (alternative.dateOffsetDays === 1 ? "" : "s") + ")"
        : alternative.flightDate
    });
  }

  function prepareOpportunityResult(result) {
    if (!result) return result;

    const currency = result.decisionCurrency || result.sourceCurrency || "";
    const nearbyAirports = (Array.isArray(result.nearbyAirports) ? result.nearbyAirports : []).map(function (airport) {
      return Object.assign({}, airport, {
        roleText: airport.role === "ORIGIN" ? "Origin area" : "Destination area",
        distanceDisplay: round2(airport.distanceKm),
        sourceCoordinatesText: formatCoordinate(airport.sourceLatitude) + ", " + formatCoordinate(airport.sourceLongitude),
        coordinatesText: formatCoordinate(airport.latitude) + ", " + formatCoordinate(airport.longitude),
        cityCountryText: (airport.city || "-") + " / " + (airport.country || "-")
      });
    });

    const allAlternatives = [];
    const legs = (Array.isArray(result.legs) ? result.legs : []).map(function (leg, index) {
      const bestAlternative = prepareOpportunityAlternative(leg.bestAlternative, currency);
      const alternatives = (Array.isArray(leg.alternatives) ? leg.alternatives : []).map(function (alternative) {
        const prepared = prepareOpportunityAlternative(alternative, currency);
        const row = Object.assign({}, prepared, {
          legNumber: leg.legNumber || index + 1,
          originalRouteText: [leg.originalRouteFrom, leg.originalRouteTo].filter(Boolean).join(" → ")
        });
        allAlternatives.push(row);
        return row;
      });

      return Object.assign({}, leg, {
        legTitle: "Leg " + (leg.legNumber || index + 1),
        originalRouteText: [leg.originalRouteFrom, leg.originalRouteTo].filter(Boolean).join(" → "),
        originalFlightText: [leg.originalCarrierId, leg.originalConnectionId].filter(Boolean).join(" "),
        originalDetailText: [[leg.originalCarrierId, leg.originalConnectionId].filter(Boolean).join(" "), leg.flightDate].filter(Boolean).join(" · "),
        selectedTotalDisplay: round2(leg.selectedTotal),
        statusState: mapStatusState(leg.status),
        bestAlternative: bestAlternative,
        bestRouteText: bestAlternative ? bestAlternative.routeText : "-",
        bestAdjustedTotalDisplay: bestAlternative ? bestAlternative.adjustedTotalDisplay : null,
        bestNetSavingDisplay: bestAlternative ? bestAlternative.netSavingDisplay : null,
        bestNetSavingPercentDisplay: bestAlternative ? bestAlternative.netSavingPercentDisplay : null,
        alternatives: alternatives,
        currency: currency
      });
    });

    return Object.assign({}, result, {
      overallStatusState: mapStatusState(result.overallStatus),
      assessmentCompletenessState: mapStatusState(result.assessmentCompleteness),
      overallMessageType: opportunityMessageType(result.overallStatus),
      nearbyAirports: nearbyAirports,
      legs: legs,
      allAlternatives: allAlternatives,
      resultVisible: true,
      radiusSummaryText: "GPS search radius " + result.radiusKm + " km · ±" + result.expandedWindowDays + " day(s)",
      thresholdSummaryText: "Estimated extra cost " + result.airportChangePenalty + " " + currency + " per changed airport and passenger · Material from " + result.minimumNetSavingAmount + " " + currency + " and " + result.minimumNetSavingPercent + "% net saving",
      gpsSummaryText: result.nearbyAirportCount + " nearby airport row(s) and " + result.searchedCandidateCount + " different-route flight candidate(s) found",
      fxSummaryText: "FX date " + (result.fxRateDate || "-") + " · Rate " + (result.fxRate == null ? "-" : result.fxRate) + " · " + (result.fxSource || "-")
    });
  }

  function normalizePositiveNumber(value, fallbackValue) {
    const num = parseFloat(value);
    return Number.isFinite(num) && num > 0 ? num : fallbackValue;
  }  

  function normalizeNonNegativeNumber(value, fallbackValue) {
    const num = parseFloat(value);
    return Number.isFinite(num) && num >= 0 ? num : fallbackValue;
  }

return {
    _ensureCostFilters: function () {
        const oUi = this._ui();
        const current = oUi.getProperty("/costFilters") || {};
  
        oUi.setProperty("/costFilters",  Object.assign({}, current, {
          benchmarkExpansionThreshold: normalizePositiveNumber(current.benchmarkExpansionThreshold, 6),
          expandedWindowDays: normalizeNonNegativeNumber(current.expandedWindowDays, 2),
          nearbyRadiusKm: normalizePositiveNumber(current.nearbyRadiusKm, 150),
          acceptableThresholdPercent: normalizePositiveNumber(current.acceptableThresholdPercent, 10),
          decisionCurrency: String(current.decisionCurrency || oUi.getProperty("/selectedTargetCurrency") || "EUR").toUpperCase(),
        }));
      },      
  
      _getCostFilters: function () {
        this._ensureCostFilters();
        const filters = this._ui().getProperty("/costFilters") || {};
        return {
          benchmarkExpansionThreshold: normalizePositiveNumber(filters.benchmarkExpansionThreshold, 6),
          expandedWindowDays: normalizeNonNegativeNumber(filters.expandedWindowDays, 2),
          nearbyRadiusKm: normalizePositiveNumber(filters.nearbyRadiusKm, 150),
          acceptableThresholdPercent: normalizePositiveNumber(filters.acceptableThresholdPercent, 10),
          decisionCurrency: String(filters.decisionCurrency || this._ui().getProperty("/selectedTargetCurrency") || "EUR").toUpperCase()
          };
      },
  
      onCostFilterChange: function () {
        const oUi = this._ui();
        const current = oUi.getProperty("/costFilters") || {};
  
        const normalized = this._getCostFilters();
        oUi.setProperty("/costFilters",  Object.assign({}, current, {
          benchmarkExpansionThreshold: normalizePositiveNumber(current.benchmarkExpansionThreshold, 6),
          expandedWindowDays: normalizeNonNegativeNumber(current.expandedWindowDays, 2),
          nearbyRadiusKm: normalizePositiveNumber(current.nearbyRadiusKm, 150),
          acceptableThresholdPercent: normalizePositiveNumber(current.acceptableThresholdPercent, 10),
          decisionCurrency: String(current.decisionCurrency || oUi.getProperty("/selectedTargetCurrency") || "EUR").toUpperCase(),
        }));
        oUi.setProperty("/costOpportunity", null);
        oUi.setProperty("/costOpportunityPretty", "");
      },
  
      _ensureOpportunityFilters: function () {
        const oUi = this._ui();
        const current = oUi.getProperty("/opportunityFilters") || {};
        oUi.setProperty("/opportunityFilters", Object.assign({}, current, {
          airportChangePenalty: normalizeNonNegativeNumber(current.airportChangePenalty, 30),
          minimumNetSavingAmount: normalizeNonNegativeNumber(current.minimumNetSavingAmount, 50),
          minimumNetSavingPercent: normalizeNonNegativeNumber(current.minimumNetSavingPercent, 10)
        }));
      },

      _getOpportunityFilters: function () {
        this._ensureOpportunityFilters();
        const costFilters = this._getCostFilters();
        const opportunityFilters = this._ui().getProperty("/opportunityFilters") || {};

        return {
          nearbyRadiusKm: normalizePositiveNumber(costFilters.nearbyRadiusKm, 50),
          expandedWindowDays: normalizeNonNegativeNumber(costFilters.expandedWindowDays, 0),
          decisionCurrency: String(costFilters.decisionCurrency || "EUR").toUpperCase(),
          airportChangePenalty: normalizeNonNegativeNumber(opportunityFilters.airportChangePenalty, 30),
          minimumNetSavingAmount: normalizeNonNegativeNumber(opportunityFilters.minimumNetSavingAmount, 50),
          minimumNetSavingPercent: normalizeNonNegativeNumber(opportunityFilters.minimumNetSavingPercent, 10)
        };
      },

      onOpportunityFilterChange: function () {
        this._ensureOpportunityFilters();
        this._ui().setProperty("/costOpportunity", null);
        this._ui().setProperty("/costOpportunityPretty", "");
      },

      async onCheckCheaperOpportunities() {
        const receiptId = this._getSelectedReceiptId();
        if (!receiptId) return MessageBox.warning("Select a receipt first.");

        const oUi = this._ui();
        oUi.setProperty("/opportunityBusy", true);

        try {
          const filters = this._getOpportunityFilters();
          const result = await CopilotApi.checkCheaperOpportunities(receiptId, filters);
          const prepared = prepareOpportunityResult(result);
          oUi.setProperty("/costOpportunity", prepared);
          oUi.setProperty("/costOpportunityPretty", this._pretty(result));
          this._selectResultTab("cost");
          MessageToast.show("Nearby-airport opportunity check loaded");
        } catch (e) {
          MessageBox.error(e.message || "Could not check cheaper opportunities.");
        } finally {
          oUi.setProperty("/opportunityBusy", false);
        }
      },
  
      _setActiveCostLeg: function (legKey) {
        const oUi = this._ui();
        const groups = oUi.getProperty("/cost/legGroups") || [];
        const wantedKey = String(legKey || "");
        const active = groups.find(function (group) {
          return String(group && group.legKey || "") === wantedKey;
        }) || groups[0] || null;

        oUi.setProperty("/cost/activeLegKey", active ? active.legKey : "");
        oUi.setProperty("/cost/activeLegGroup", active);
      },

      onCostLegSelectionChange: function (oEvent) {
        const item = oEvent && oEvent.getParameter && oEvent.getParameter("item");
        const key = item && item.getKey ? item.getKey() : this._ui().getProperty("/cost/activeLegKey");
        this._setActiveCostLeg(key);
      },

      async onAssessCost() {
        const receiptId = this._getSelectedReceiptId();
        if (!receiptId) return MessageBox.warning("Select a receipt first.");
  
        try {
          const filters = this._getCostFilters();
          const result = await CopilotApi.assessCostEfficiency(receiptId, filters);
          const prepared = prepareCostResult(result);
          this._ui().setProperty("/cost", prepared);
          this._setActiveCostLeg(prepared && prepared.activeLegKey);
          this._ui().setProperty("/costPretty", this._pretty(result));
  
          this._selectResultTab("cost");
  
          MessageToast.show("Cost efficiency loaded");
  
  
        } catch (e) {
          MessageBox.error(e.message);
        }
      },
    }
});
