module.exports = function registerCostEfficiencyHandler(service, deps) {
  const { SELECT, entities, adapters } = deps;
  const { Receipts } = entities;
  const {
    loadTravelAndBookings,
    loadComparableFlightPrices,
    resolveNearbyAirports,
  } = adapters;

  // 1) Benchmark settings and deterministic decision helpers.
  const DEFAULT_BENCHMARK_EXPANSION_THRESHOLD = 3;
  const DEFAULT_EXPANDED_WINDOW_DAYS = 0;
  const DEFAULT_NEARBY_RADIUS_KM = 1;
  const DEFAULT_ACCEPTABLE_THRESHOLD_PERCENT = 10;

    const toPositiveInt = (value, fallbackValue) => {
      const num = parseInt(value, 10);
      return Number.isFinite(num) && num > 0 ? num : fallbackValue;
    };
  
    const round2 = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Number(Number(value).toFixed(2));

  const sumItems = (items, predicate) =>
    (Array.isArray(items) ? items : [])
      .filter(predicate)
      .reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

  const median = (values) => {
    const nums = values
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };

  const getBenchmarkStrength = (count, benchmarkMode, bestAlternative) => {
    if (!count) return "NONE";
  
    if (benchmarkMode !== "EXPANDED") {
      if (count === 1) return "LOW";
      if (count <= 3) return "MEDIUM";
      return "HIGH";
    }
  
    const matchTier = bestAlternative?.matchMeta?.matchTier;
  
    if (matchTier == null) {
      if (count === 1) return "LOW";
      if (count <= 3) return "MEDIUM";
      return "MEDIUM";
    }
  
    if (matchTier <= 2) {
      if (count === 1) return "LOW";
      if (count <= 3) return "MEDIUM";
      return "HIGH";
    }
  
    if (matchTier <= 5) {
      if (count === 1) return "LOW";
      if (count <= 3) return "LOW";
      return "MEDIUM";
    }
  
    return "LOW";
  };

  // Decision rule: benchmark price -> GOOD / ACCEPTABLE / REVIEW.
  const classifyStatus = (selectedPrice, benchmarkPrice, acceptableThresholdPercent) => {
    if (!(benchmarkPrice > 0)) return "INSUFFICIENT_DATA";
    const pct = Number.isFinite(Number(acceptableThresholdPercent)) ? Number(acceptableThresholdPercent) : DEFAULT_ACCEPTABLE_THRESHOLD_PERCENT;
    const multiplier = 1 + pct / 100;
    if (selectedPrice <= benchmarkPrice) return "GOOD";
    if (selectedPrice <= benchmarkPrice * multiplier) return "ACCEPTABLE";
    return "REVIEW";
  };

  const normalizeId = (value) => String(value ?? "")
      .trim()
      .replace(/^0+/, "")
      .toUpperCase();

  const normalizeDate = (value) =>  value ? String(value).slice(0, 10) : "";

  const getReceiptFlightLegs = (ex) => Array.isArray(ex?.flightLegs) ? ex.flightLegs : [];


  const getLegLabel = (leg, index) => {
    const raw = leg?.leg ?? leg?.legNo ?? leg?.sequence ?? (index + 1);
    return String(raw || index + 1);
  };

  const formatLegRoute = (leg) => {
    const from = leg?.fromAirport || leg?.routeFrom || "";
    const to = leg?.toAirport || leg?.routeTo || "";
    if (from || to) return [from, to].filter(Boolean).join(" -> ");
    return leg?.route || "";
  };

  const summarizeReceiptFlightLeg = (leg, index) => ({
    leg: leg?.leg ?? index + 1,
    route: leg?.route || formatLegRoute(leg),
    carrierId: leg?.carrierId ?? null,
    flightNumber: leg?.flightNumber ?? leg?.connectionId ?? null,
    flightDate: leg?.flightDate ?? null,
    fromAirport: leg?.fromAirport ?? leg?.routeFrom ?? null,
    toAirport: leg?.toAirport ?? leg?.routeTo ?? null,
    currency: leg?.currency ?? null,
  });

  const receiptAirfareItemMatchesLeg = (item, leg, index) => {
    if (!item || String(item.type || "").toLowerCase() !== "airfare") return false;

    const legLabel = getLegLabel(leg, index);
    const description = String(item.description || "");
    if (legLabel && new RegExp("\\bLeg\\s*" + legLabel + "\\b", "i").test(description)) {
      return true;
    }

    if (item.bookingId && leg?.bookingId && normalizeId(item.bookingId) === normalizeId(leg.bookingId)) {
      return true;
    }

    const sameCarrier = item.carrierId && leg?.carrierId && normalizeId(item.carrierId) === normalizeId(leg.carrierId);
    const sameFlight = (item.flightNumber || item.dmoConnectionId) && (leg?.flightNumber || leg?.connectionId) &&
      normalizeId(item.flightNumber || item.dmoConnectionId) === normalizeId(leg.flightNumber || leg.connectionId);
    const sameDate = item.flightDate && leg?.flightDate && normalizeDate(item.flightDate) === normalizeDate(leg.flightDate);

    return !!(sameCarrier && sameDate && (sameFlight || !item.flightNumber));
  };

  const estimateReceiptAirfareForLeg = (leg, index, airfareItems, customerCount) => {
    const matchingItems = (Array.isArray(airfareItems) ? airfareItems : [])
      .filter((item) => receiptAirfareItemMatchesLeg(item, leg, index));

    if (matchingItems.length) {
      return round2(matchingItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
    }

    const farePerPassenger = Number(leg?.farePerPassenger);
    const passengers = Number(customerCount || 0);
    if (Number.isFinite(farePerPassenger) && farePerPassenger > 0 && passengers > 0) {
      return round2(farePerPassenger * passengers);
    }

    return null;
  };
  
  // Keep the original currency view and the selected company decision-currency view separate.
  const normalizeCurrency = (value) => {
    const s = String(value || "").trim().toUpperCase();
    return /^[A-Z]{3}$/.test(s) ? s : null;
  };

  const convertByRate = (amount, rate) => {
    const n = Number(amount);
    return Number.isFinite(n) ? round2(n * Number(rate || 1)) : null;
  };

  const convertAlternativeToDecisionCurrency = (alt, sourceCurrency, decisionCurrency, rate) => {
    if (!alt) return null;
    return {
      ...alt,
      priceSource: round2(alt.price),
      sourceCurrency: alt.currency || sourceCurrency || null,
      price: convertByRate(alt.price, rate),
      currency: decisionCurrency || alt.currency || sourceCurrency || null,
    };
  };

  const convertAlternativeListToDecisionCurrency = (items, sourceCurrency, decisionCurrency, rate) =>
    (Array.isArray(items) ? items : []).map((alt) =>
      convertAlternativeToDecisionCurrency(alt, sourceCurrency, decisionCurrency, rate)
    );

  const buildDecision = ({ currency, selectedTotal, benchmarkTotal, status, basis, rateDate, rate }) => {
    const difference =
      selectedTotal != null && benchmarkTotal != null
        ? round2(Number(selectedTotal) - Number(benchmarkTotal))
        : null;

    const differencePercent =
      benchmarkTotal > 0 && difference != null
        ? round2((difference / Number(benchmarkTotal)) * 100)
        : null;

    return {
      currency: currency || null,
      selectedTotal: round2(selectedTotal),
      benchmarkTotal: round2(benchmarkTotal),
      difference,
      differencePercent,
      status,
      basis,
      rateDate: rateDate || null,
      rate: rate == null ? null : Number(rate),
    };
  };

  const addDays = (isoDate, offset) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const diffDays = (dateA, dateB) => {
    if (!dateA || !dateB) return 99;
    const a = new Date(`${dateA}T00:00:00Z`);
    const b = new Date(`${dateB}T00:00:00Z`);
    return Math.round(Math.abs(a - b) / 86400000);
  };

  const normalizeAirportIds = (baseAirportId, nearby) => {
    const ids = new Set();
    if (baseAirportId) ids.add(String(baseAirportId).toUpperCase());

    for (const airport of nearby?.nearbyAirports || []) {
      const iata = String(airport?.iata || "").trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(iata)) ids.add(iata);
    }

    return [...ids];
  };

  // Comparability tiers prefer exact route/date before controlled date or airport differences.
  const buildMatchMetadata = (alt, bookingContext) => {
    const fromMatches = alt?.routeFrom === bookingContext.fromAirport;
    const toMatches = alt?.routeTo === bookingContext.toAirport;
    const sameRoute = fromMatches && toMatches;
    const sameDate = alt?.flightDate === bookingContext.flightDate;
    const dateOffsetDays = diffDays(alt?.flightDate, bookingContext.flightDate);
    const airportChanges = (fromMatches ? 0 : 1) + (toMatches ? 0 : 1);

    let matchTier = 8;
    if (sameRoute && sameDate) matchTier = 0;
    else if (sameRoute && dateOffsetDays <= 1) matchTier = 1;
    else if (airportChanges === 1 && sameDate) matchTier = 2;
    else if (sameRoute && dateOffsetDays <= 2) matchTier = 3;
    else if (airportChanges === 1 && dateOffsetDays <= 1) matchTier = 4;
    else if (airportChanges === 2 && sameDate) matchTier = 5;
    else if (airportChanges === 1 && dateOffsetDays <= 2) matchTier = 6;
    else if (airportChanges === 2 && dateOffsetDays <= 1) matchTier = 7;
    else if (airportChanges === 2 && dateOffsetDays <= 3) matchTier = 8;

    return {
      sameRoute,
      sameDate,
      fromMatches,
      toMatches,
      airportChanges,
      dateOffsetDays,
      matchTier,
    };
  };

  const describeAlternative = (alt, bookingContext) => {
    const meta = alt?.matchMeta || buildMatchMetadata(alt, bookingContext);

    if (meta.sameRoute && meta.sameDate) {
      return "a like-for-like option on the same route and date";
    }
    if (meta.sameRoute) {
      return `the same route within a plus/minus ${meta.dateOffsetDays} day window`;
    }
    if (meta.sameDate) {
      if (!meta.fromMatches && meta.toMatches) {
        return "a nearby-origin option on the same date";
      }
      if (meta.fromMatches && !meta.toMatches) {
        return "a nearby-destination option on the same date";
      }
      return "nearby-airport options on the same date";
    }
    return `nearby-airport options with about ${meta.dateOffsetDays} day date flexibility`;
  };

  // Ranking priority: comparability first, price second.
  const rankAlternatives = (alternatives, bookingContext) => {
    return [...alternatives]
      .map((alt) => ({
        ...alt,
        price: Number(alt.price || 0),
        matchMeta: buildMatchMetadata(alt, bookingContext),
      }))
      .filter((alt) => Number.isFinite(alt.price))
      .sort((a, b) => {
        if (a.matchMeta.matchTier !== b.matchMeta.matchTier) {
          return a.matchMeta.matchTier - b.matchMeta.matchTier;
        }
        if (a.price !== b.price) return a.price - b.price;
        if (a.matchMeta.dateOffsetDays !== b.matchMeta.dateOffsetDays) {
          return a.matchMeta.dateOffsetDays - b.matchMeta.dateOffsetDays;
        }
        if (a.matchMeta.airportChanges !== b.matchMeta.airportChanges) {
          return a.matchMeta.airportChanges - b.matchMeta.airportChanges;
        }
        return String(a.flightDate || "").localeCompare(String(b.flightDate || ""));
      });
  };

  // Expanded candidate set: nearby airports + configured date window.
  const loadExpandedAlternatives = async ({
    fromAirportIds,
    toAirportIds,
    flightDate,
    bookingCurrency,
    expandedWindowDays = DEFAULT_EXPANDED_WINDOW_DAYS,
  }) => {
    const startDate = addDays(flightDate, -expandedWindowDays);
    const endDate = addDays(flightDate, expandedWindowDays);

    const [connections, flights] = await Promise.all([
      SELECT.from("demo.copilot.Connections"),
      SELECT.from("demo.copilot.Flights"),
    ]);

    const filteredConnections = connections.filter(
      (c) =>
        fromAirportIds.includes(String(c.AirportFromID || "").toUpperCase()) &&
        toAirportIds.includes(String(c.AirportToID || "").toUpperCase())
    );

    const connectionMap = new Map(
      filteredConnections.map((c) => [`${c.CarrierID}::${c.ConnectionID}`, c])
    );

    const alternatives = flights
      .filter((f) => {
        const key = `${f.CarrierID}::${f.ConnectionID}`;
        return (
          connectionMap.has(key) &&
          String(f.FlightDate) >= startDate &&
          String(f.FlightDate) <= endDate &&
          (!bookingCurrency || !f.CurrencyCode || f.CurrencyCode === bookingCurrency)
        );
      })
      .map((f) => {
        const key = `${f.CarrierID}::${f.ConnectionID}`;
        const connection = connectionMap.get(key);
        return {
          carrierId: f.CarrierID ?? null,
          connectionId: f.ConnectionID ?? null,
          flightDate: f.FlightDate ?? null,
          routeFrom: connection?.AirportFromID ?? null,
          routeTo: connection?.AirportToID ?? null,
          price: Number(f.Price || 0),
          currency: f.CurrencyCode ?? bookingCurrency ?? null,
          scope: "EXPANDED",
        };
      })
      .filter((a) => Number.isFinite(a.price));

    const unique = [];
    const seen = new Set();
    for (const alt of alternatives) {
      const key = `${alt.carrierId}::${alt.connectionId}::${alt.flightDate}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(alt);
      }
    }

    return unique;
  };


  const mapAlternativeForResponse = (alt, bookingCurrency) => ({
    carrierId: alt?.carrierId ?? null,
    connectionId: alt?.connectionId ?? null,
    flightDate: alt?.flightDate ?? null,
    routeFrom: alt?.routeFrom ?? null,
    routeTo: alt?.routeTo ?? null,
    price: round2(alt?.price),
    currency: alt?.currency ?? bookingCurrency ?? null,
    scope: alt?.scope ?? null,
  });

  const pickNamedAlternatives = (rankedAlternatives, bookingCurrency) => {
    if (!rankedAlternatives.length) {
      return {
        benchmarkAlternative: null,
        cheapestAlternative: null,
        referenceAlternative: null,
        allAlternatives: [],
        alternatives: [],
      };
    }

    const benchmarkAlternative = rankedAlternatives[0] ?? null;

    const priceSorted = [...rankedAlternatives].sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      return String(a.flightDate || "").localeCompare(String(b.flightDate || ""));
    });

    const cheapestAlternative = priceSorted[0] ?? null;
    const referenceAlternative =
      priceSorted[Math.floor((priceSorted.length - 1) / 2)] ?? null;

    const alternatives = [
      benchmarkAlternative,
      cheapestAlternative,
      referenceAlternative,
    ].map((alt) => mapAlternativeForResponse(alt, bookingCurrency));

    const allAlternatives = rankedAlternatives.map((alt) =>
      mapAlternativeForResponse(alt, bookingCurrency)
    );

    return {
      benchmarkAlternative: mapAlternativeForResponse(benchmarkAlternative, bookingCurrency),
      cheapestAlternative: mapAlternativeForResponse(cheapestAlternative, bookingCurrency),
      referenceAlternative: mapAlternativeForResponse(referenceAlternative, bookingCurrency),
      allAlternatives,
      alternatives,
    };
  };

  const buildLineRationale = ({
    status,
    benchmarkMode,
    comparableCount,
    bestAlternative,
    bookingContext,
  }) => {
    if (!comparableCount) {
      return "No realistic comparison flights were found in the benchmark set.";
    }
  
    if (!bestAlternative) {
      return "Benchmark found comparison flights, but no best alternative could be ranked confidently.";
    }
  
    const comparisonText = describeAlternative(bestAlternative, bookingContext);
    const matchTier = bestAlternative?.matchMeta?.matchTier ?? 99;
    const isExactLikeForLike = matchTier === 0;
  
    if (status === "GOOD") {
      if (benchmarkMode !== "EXPANDED") {
        return `Booked fare looks good against ${comparisonText}.`;
      }
  
      return isExactLikeForLike
        ? "Booked fare looks good against like-for-like alternatives on the same route and date. Expanded search was used to improve coverage, but the best benchmark options remained highly comparable to the booked itinerary."
        : `Booked fare looks good even when compared with ${comparisonText}.`;
    }
  
    if (status === "ACCEPTABLE") {
      if (benchmarkMode !== "EXPANDED") {
        return `Booked fare looks acceptable against ${comparisonText}.`;
      }
  
      return isExactLikeForLike
        ? "Booked fare looks acceptable against like-for-like alternatives on the same route and date. Expanded search was used to improve coverage, but the best benchmark options remained highly comparable to the booked itinerary."
        : `Booked fare looks acceptable against ${comparisonText}. Treat this as a broader opportunity benchmark, not a strict like-for-like comparison.`;
    }
  
    if (status === "REVIEW") {
      if (benchmarkMode !== "EXPANDED") {
        return `Booked fare is clearly above cheaper options found for ${comparisonText}.`;
      }
  
      return isExactLikeForLike
        ? "Booked fare is above cheaper like-for-like alternatives found on the same route and date. Expanded search was used to improve coverage, but the best benchmark options remained highly comparable to the booked itinerary."
        : `Booked fare is above cheaper alternatives found via ${comparisonText}. Treat this as an opportunity benchmark that allows limited flexibility in airport choice and/or travel date.`;
    }
  
    return "Not enough benchmark data to judge this booking confidently.";
  };

  const buildOverallStatus = (lineResults) => {
    if (!lineResults.length) return "INSUFFICIENT_DATA";
    if (lineResults.some((l) => l.status === "REVIEW")) return "REVIEW";
    if (lineResults.some((l) => l.status === "INSUFFICIENT_DATA")) return "INSUFFICIENT_DATA";
    if (lineResults.some((l) => l.status === "ACCEPTABLE")) return "ACCEPTABLE";
    return "GOOD";
  };


  const statusRank = { INSUFFICIENT_DATA: 0, GOOD: 1, ACCEPTABLE: 2, REVIEW: 3 };

  const worstStatus = (values) => {
    const statuses = (Array.isArray(values) ? values : []).filter(Boolean);
    if (!statuses.length) return "INSUFFICIENT_DATA";
    return statuses.sort((a, b) => (statusRank[b] || 0) - (statusRank[a] || 0))[0];
  };

  const groupKeyForLine = (line) => [
    line?.carrierId || "",
    line?.flightDate || "",
    line?.routeFrom || "",
    line?.routeTo || "",
    line?.sourceCurrency || "",
    line?.decisionCurrency || "",
    line?.selectedPriceSource ?? "",
    line?.benchmarkPriceSource ?? "",
  ].join("::");

  // Group booking-level calculations into one business decision per flight leg.
  const buildLegGroups = (lineResults) => {
    const groups = new Map();

    for (const line of Array.isArray(lineResults) ? lineResults : []) {
      const key = groupKeyForLine(line);
      const existing = groups.get(key);

      if (!existing) {
        groups.set(key, {
          groupKey: key,
          carrierId: line.carrierId ?? null,
          flightDate: line.flightDate ?? null,
          routeFrom: line.routeFrom ?? null,
          routeTo: line.routeTo ?? null,
          sourceCurrency: line.sourceCurrency ?? null,
          decisionCurrency: line.decisionCurrency ?? null,
          passengerCount: 1,
          bookingCount: 1,
          bookingIds: [line.bookingId].filter(Boolean),
          selectedPricePerPassengerSource: round2(line.selectedPriceSource),
          benchmarkPricePerPassengerSource: round2(line.benchmarkPriceSource),
          benchmarkMedianPricePerPassengerSource: round2(line.benchmarkMedianPriceSource),
          selectedPricePerPassenger: round2(line.selectedPrice),
          benchmarkPricePerPassenger: round2(line.benchmarkPrice),
          benchmarkMedianPricePerPassenger: round2(line.benchmarkMedianPrice),
          selectedTotalSource: round2(line.selectedPriceSource),
          benchmarkTotalSource: round2(line.benchmarkPriceSource),
          benchmarkMedianTotalSource: round2(line.benchmarkMedianPriceSource),
          selectedTotal: round2(line.selectedPrice),
          benchmarkTotal: round2(line.benchmarkPrice),
          benchmarkMedianTotal: round2(line.benchmarkMedianPrice),
          comparableCount: line.comparableCount ?? null,
          benchmarkMode: line.benchmarkMode ?? null,
          benchmarkStrength: line.benchmarkStrength ?? null,
          sourceStatus: line.sourceStatus ?? null,
          decisionStatus: line.decisionStatus ?? null,
          status: line.status ?? null,
          sourceDecision: null,
          selectedCurrencyDecision: null,
          rationale: line.rationale ?? null,
          benchmarkAlternative: line.benchmarkAlternative ?? null,
          cheapestAlternative: line.cheapestAlternative ?? null,
          referenceAlternative: line.referenceAlternative ?? null,
          allAlternatives: line.allAlternatives ?? [],
          alternatives: line.alternatives ?? [],
        });
        continue;
      }

      existing.passengerCount += 1;
      existing.bookingCount += 1;
      if (line.bookingId) existing.bookingIds.push(line.bookingId);
      existing.selectedTotalSource = round2(Number(existing.selectedTotalSource || 0) + Number(line.selectedPriceSource || 0));
      existing.benchmarkTotalSource = round2(Number(existing.benchmarkTotalSource || 0) + Number(line.benchmarkPriceSource || 0));
      existing.benchmarkMedianTotalSource = round2(Number(existing.benchmarkMedianTotalSource || 0) + Number(line.benchmarkMedianPriceSource || 0));
      existing.selectedTotal = round2(Number(existing.selectedTotal || 0) + Number(line.selectedPrice || 0));
      existing.benchmarkTotal = round2(Number(existing.benchmarkTotal || 0) + Number(line.benchmarkPrice || 0));
      existing.benchmarkMedianTotal = round2(Number(existing.benchmarkMedianTotal || 0) + Number(line.benchmarkMedianPrice || 0));
      existing.sourceStatus = worstStatus([existing.sourceStatus, line.sourceStatus]);
      existing.decisionStatus = worstStatus([existing.decisionStatus, line.decisionStatus]);
      existing.status = worstStatus([existing.status, line.status]);
    }

    return [...groups.values()].map((group, index) => {
      group.sourceDecision = buildDecision({
        currency: group.sourceCurrency,
        selectedTotal: group.selectedTotalSource,
        benchmarkTotal: group.benchmarkTotalSource,
        status: group.sourceStatus,
        basis: "Grouped flight-leg decision in original purchase/booked currency.",
        rateDate: null,
        rate: 1,
      });

      group.selectedCurrencyDecision = buildDecision({
        currency: group.decisionCurrency,
        selectedTotal: group.selectedTotal,
        benchmarkTotal: group.benchmarkTotal,
        status: group.decisionStatus,
        basis: "Grouped flight-leg decision in selected company decision currency.",
        rateDate: null,
        rate: null,
      });

      group.lineTitle = "Leg " + (index + 1) + " · " + [group.routeFrom, group.routeTo].filter(Boolean).join(" -> ");
      group.lineSubtitle = [
        group.flightDate,
        group.carrierId,
        String(group.passengerCount || 0) + " passenger booking" + (group.passengerCount === 1 ? "" : "s"),
        group.benchmarkMode,
      ].filter(Boolean).join(" · ");
      group.rationale = group.rationale || "Grouped cost decision for passenger bookings with the same flight leg and fare.";
      return group;
    });
  };

  const buildAssessmentRationale = ({ benchmarkMode, lineResults }) => {
    if (!lineResults.length) {
      return "No benchmarkable flight lines were found for this receipt.";
    }
  
    if (benchmarkMode === "STRICT") {
      return "Benchmark checked the exact route and date for each flight line and compares the booked fare against the best like-for-like alternatives found in the local DMO flight catalog.";
    }
  
    const exactLikeForLikeExpanded = lineResults.filter(
      (l) => l.benchmarkMode === "EXPANDED" && l.bestAlternativeMeta?.matchTier === 0
    ).length;
  
    const broaderExpanded = lineResults.filter(
      (l) => l.benchmarkMode === "EXPANDED" && (l.bestAlternativeMeta?.matchTier ?? 99) > 0
    ).length;
    
    if (broaderExpanded && exactLikeForLikeExpanded) {
      return "Benchmark first checked exact route and date. Where that market was too thin, it expanded to nearby airports within the configured date window. Some cheaper alternatives still remained like-for-like, while others required limited flexibility, so this should be read as a broader opportunity benchmark.";
    }
    
    if (broaderExpanded) {
      return "Benchmark first checked exact route and date. Because that market was too thin, it expanded to nearby airports within the configured date window. The result highlights cheaper alternatives that require limited flexibility, rather than only strict like-for-like substitutions.";
    }
    
    return "Benchmark first checked exact route and date. Expanded search was used to improve coverage, but the best alternatives remained like-for-like or near-like-for-like matches to the booked itinerary.";
  };

  // 2) Main Cost Assessment action and effective benchmark settings.
  service.on("assessCostEfficiency", async (req) => {
    const {
      receiptId,
      benchmarkExpansionThreshold,
      expandedWindowDays,
      nearbyRadiusKm,
      acceptableThresholdPercent,
      decisionCurrency,
    } = req.data || {};

    if (!receiptId) return req.reject(400, "receiptId is required");

    const toNonNegativeInt = (value, fallbackValue) => {
      const num = parseInt(value, 10);
      return Number.isFinite(num) && num >= 0 ? num : fallbackValue;
    };

    const effectiveBenchmarkExpansionThreshold = toPositiveInt(
      benchmarkExpansionThreshold,
      DEFAULT_BENCHMARK_EXPANSION_THRESHOLD
    );

    const effectiveExpandedWindowDays = toNonNegativeInt(
      expandedWindowDays,
      DEFAULT_EXPANDED_WINDOW_DAYS
    );
    const effectiveNearbyRadiusKm = toPositiveInt(nearbyRadiusKm, DEFAULT_NEARBY_RADIUS_KM);
    
    const benchmarkScope =
      "Exact route/date first. If that is too thin, expand to nearby airports and plus/minus " +
      effectiveExpandedWindowDays +
      " days in the local DMO flight catalog. Benchmark expansion threshold=" +
      effectiveBenchmarkExpansionThreshold +
      ", nearby radius=" +
      effectiveNearbyRadiusKm +
      " km.";

    const r = await SELECT.one.from(Receipts).where({ ID: receiptId });
    if (!r) return req.reject(404, "Receipt not found");
    if (!r.extractedJson) return req.reject(400, "Extract first");

    let ex;
    try {
      ex = JSON.parse(r.extractedJson);
    } catch {
      return req.reject(400, "Extracted JSON is invalid");
    }

    const travelId = ex.travelId ?? r.travelId;
    if (!travelId) {
      return req.reject(400, "No travelId available. Extract first or set travelId.");
    }

    // Load the extracted receipt plus the corresponding local DMO travel and bookings.
    const { travel, bookings } = await loadTravelAndBookings(travelId);
    if (!travel) {
      return req.reject(404, `Travel ${travelId} not found in local DMO data`);
    }

    const items = Array.isArray(ex.items) ? ex.items : [];
    const airfareItems = items.filter(
      (it) => String(it.type || "").toLowerCase() === "airfare"
    );
    const airfareOriginal = sumItems(
      airfareItems,
      () => true
    );
    const nonAirfareOriginal = sumItems( items, (it) => String(it.type || "").toLowerCase() !== "airfare" );
    const fullReceiptTotal = Number(ex.totalAmount ?? r.totalAmount ?? 0);

    const extractedCustomers = Array.isArray(ex.customers)
      ? ex.customers
      : Array.isArray(ex.passengers)
        ? ex.passengers
        : [];

    const customerCount = Number(
      ex.customerCount || ex.passengerCount || extractedCustomers.length || 0
    );

    // Receipt integrity starts by matching each structured leg to DMO carrier, flight, date and route.
    const bookingMatchesReceiptLeg = async (booking, flightLeg, SELECT) => {
      const connection = await SELECT.one.from("demo.copilot.Connections").where({
        CarrierID: booking.CarrierID,
        ConnectionID: booking.ConnectionID,
      });

      const bookingCarrier = normalizeId(booking.CarrierID);
      const bookingConnection = normalizeId(booking.ConnectionID);
      const bookingDate = normalizeDate(booking.FlightDate);

      const legCarrier = normalizeId(flightLeg.carrierId);
      const legFlightNumber = normalizeId(flightLeg.flightNumber || flightLeg.connectionId);
      const legDate = normalizeDate(flightLeg.flightDate);

      const bookingFrom = normalizeId(connection?.AirportFromID);
      const bookingTo = normalizeId(connection?.AirportToID);

      const legFrom = normalizeId(flightLeg.fromAirport || flightLeg.routeFrom);
      const legTo = normalizeId(flightLeg.toAirport || flightLeg.routeTo);

      return (
        bookingCarrier === legCarrier &&
        bookingConnection === legFlightNumber &&
        bookingDate === legDate &&
        (!legFrom || bookingFrom === legFrom) &&
        (!legTo || bookingTo === legTo)
      );
    };


    const filterBookingsForReceipt = async (bookings, ex, SELECT) => {
      const flightLegs = getReceiptFlightLegs(ex);

      if (!flightLegs.length) {
        return {
          relevantBookings: bookings,
          ignoredBookings: [],
          basis: "ALL_TRAVEL_BOOKINGS_NO_RECEIPT_FLIGHTLEGS",
          receiptFlightLegs: [],
          matchedReceiptFlightLegs: [],
          unmatchedReceiptFlightLegs: [],
          assessedAirfareSource: round2(airfareOriginal),
          unassessedAirfareSource: 0,
        };
      }

      const relevantBookings = [];
      const ignoredBookings = [];
      const legMatches = flightLegs.map((leg, index) => ({
        leg,
        index,
        matchedBookings: [],
        estimatedReceiptAirfareSource: estimateReceiptAirfareForLeg(leg, index, airfareItems, customerCount),
      }));

      for (const booking of bookings) {
        const matchedIndexes = [];

        for (let i = 0; i < flightLegs.length; i += 1) {
          if (await bookingMatchesReceiptLeg(booking, flightLegs[i], SELECT)) {
            matchedIndexes.push(i);
          }
        }

        if (matchedIndexes.length) {
          relevantBookings.push(booking);
          for (const idx of matchedIndexes) {
            legMatches[idx].matchedBookings.push(booking);
          }
        } else {
          ignoredBookings.push(booking);
        }
      }

      const receiptFlightLegs = legMatches.map((entry) => ({
        ...summarizeReceiptFlightLeg(entry.leg, entry.index),
        matchedBookingIds: entry.matchedBookings.map((b) => String(b.BookingID ?? "")),
        matchedCustomerIds: entry.matchedBookings.map((b) => String(b.CustomerID ?? "")),
        matchedBookingTotalSource: round2(entry.matchedBookings.reduce((sum, b) => sum + (Number(b.FlightPrice) || 0), 0)),
        estimatedReceiptAirfareSource: entry.estimatedReceiptAirfareSource,
        matched: entry.matchedBookings.length > 0,
        reason: entry.matchedBookings.length > 0
          ? null
          : "No matching DMO booking was found for this extracted receipt flight leg.",
      }));

      const matchedReceiptFlightLegs = receiptFlightLegs.filter((leg) => leg.matched);
      const unmatchedReceiptFlightLegs = receiptFlightLegs.filter((leg) => !leg.matched);

      const knownUnassessedAmounts = unmatchedReceiptFlightLegs
        .map((leg) => Number(leg.estimatedReceiptAirfareSource))
        .filter((value) => Number.isFinite(value));

      const unassessedAirfareSource = knownUnassessedAmounts.length
        ? round2(knownUnassessedAmounts.reduce((sum, value) => sum + value, 0))
        : null;

      const assessedAirfareSource = unassessedAirfareSource == null
        ? round2(airfareOriginal)
        : round2(Math.max(0, Number(airfareOriginal || 0) - Number(unassessedAirfareSource || 0)));

      return {
        relevantBookings,
        ignoredBookings,
        basis: "RECEIPT_FLIGHTLEGS",
        receiptFlightLegs,
        matchedReceiptFlightLegs,
        unmatchedReceiptFlightLegs,
        assessedAirfareSource,
        unassessedAirfareSource,
      };
    };

    // With structured receipt legs, benchmark only matching DMO bookings; retain unmatched legs as evidence.
    const bookingSelection = await filterBookingsForReceipt(bookings, ex, SELECT);
    const relevantBookings = bookingSelection.relevantBookings;
    const ignoredBookings = bookingSelection.ignoredBookings;
    

    const receiptFlightLegs = bookingSelection.receiptFlightLegs || [];
    const matchedReceiptFlightLegs = bookingSelection.matchedReceiptFlightLegs || [];
    const unmatchedReceiptFlightLegs = bookingSelection.unmatchedReceiptFlightLegs || [];
    const hasStructuredReceiptFlightLegs = getReceiptFlightLegs(ex).length > 0;
    const allReceiptFlightLegsMatched = hasStructuredReceiptFlightLegs && unmatchedReceiptFlightLegs.length === 0;

    // Integrity gate: VERIFIED -> final decision allowed; SUSPICIOUS -> partial benchmark only.
    const integrityStatus = hasStructuredReceiptFlightLegs
      ? (allReceiptFlightLegsMatched ? "VERIFIED" : "SUSPICIOUS")
      : "UNKNOWN";

    const costAssessmentStatus = integrityStatus === "SUSPICIOUS"
      ? (relevantBookings.length ? "PARTIAL_ONLY" : "NOT_ASSESSABLE")
      : (relevantBookings.length ? "FULL" : "INSUFFICIENT_DATA");

    const integrityWarnings = unmatchedReceiptFlightLegs.map((leg) => {
      const route = leg.route || [leg.fromAirport, leg.toAirport].filter(Boolean).join(" -> ");
      return `Receipt flight leg ${leg.leg} (${[leg.carrierId, leg.flightNumber].filter(Boolean).join(" ")}, ${leg.flightDate || "unknown date"}, ${route || "unknown route"}) was not found in DMO bookings for travel ${travel.TravelID}.`;
    });

    const assessedAirfareSource = bookingSelection.assessedAirfareSource;
    const unassessedAirfareSource = bookingSelection.unassessedAirfareSource;

    const integrityMessage = integrityStatus === "SUSPICIOUS"
      ? "Receipt is not fully credible: at least one extracted flight leg was not found in the DMO bookings. Cost efficiency is shown only as a partial benchmark for the matched legs and must not be used as the final economic decision."
      : integrityStatus === "VERIFIED"
        ? "All extracted receipt flight legs were found in DMO bookings. Cost efficiency can be used as the final economic decision."
        : "No structured receipt flight legs were available. Cost efficiency used all DMO travel bookings and should be reviewed carefully.";

    const receiptIntegrity = {
      status: integrityStatus,
      costAssessmentStatus,
      allReceiptFlightLegsMatched,
      receiptFlightLegCount: receiptFlightLegs.length,
      matchedReceiptFlightLegCount: matchedReceiptFlightLegs.length,
      unmatchedReceiptFlightLegCount: unmatchedReceiptFlightLegs.length,
      assessedAirfareSource: round2(assessedAirfareSource),
      unassessedAirfareSource: round2(unassessedAirfareSource),
      sourceCurrency: ex.currency || r.currency || null,
      message: integrityMessage,
      warnings: integrityWarnings,
      receiptFlightLegs,
      matchedReceiptFlightLegs,
      unmatchedReceiptFlightLegs,
    };


    // Build source-currency and selected decision-currency views using receipt-date FX when needed.
    const sourceCurrency = normalizeCurrency(travel.CurrencyCode) || 
      normalizeCurrency(ex.currency) || 
      normalizeCurrency(r.currency);
    const effectiveDecisionCurrency = normalizeCurrency(decisionCurrency) || sourceCurrency;
    const decisionDate = ex.receiptDate ?? r.receiptDate ?? null;

    let fx = null;
    let decisionRate = 1;

    if (sourceCurrency && effectiveDecisionCurrency && sourceCurrency !== effectiveDecisionCurrency) {
      try {
        fx = await service.send("convertFx", {
          receiptId,
          toCurrency: effectiveDecisionCurrency,
        });
        decisionRate = Number(fx?.rate || 1);
      } catch (e) {
        console.warn("assessCostEfficiency FX conversion failed", e?.message || e);
        decisionRate = 1;
      }
    } else {
      fx = {
        rateDate: decisionDate,
        base: sourceCurrency,
        symbol: effectiveDecisionCurrency,
        original: 1,
        rate: 1,
        converted: 1,
        source: "identity",
        effectiveDate: decisionDate,
      };
    }

    if (!relevantBookings.length) {
      const finalNoDataStatus = integrityStatus === "SUSPICIOUS" ? "NOT_ASSESSABLE" : "INSUFFICIENT_DATA";
      return {
        receiptId,
        travelId: String(travelId),
        bookingCurrency: sourceCurrency,
        sourceCurrency,
        decisionCurrency: effectiveDecisionCurrency,
        selectedTotalSource: round2(airfareOriginal),
        benchmarkTotalSource: null,
        selectedTotal: convertByRate(airfareOriginal, decisionRate),
        benchmarkTotal: null,
        fullReceiptTotalSource: round2(fullReceiptTotal),
        nonAirfareTotalSource: round2(nonAirfareOriginal),
        fullReceiptTotal: convertByRate(fullReceiptTotal, decisionRate),
        nonAirfareTotal: convertByRate(nonAirfareOriginal, decisionRate),
        sourceOverallStatus: finalNoDataStatus,
        overallStatus: finalNoDataStatus,
        sourceCurrencyDecision: buildDecision({
          currency: sourceCurrency,
          selectedTotal: airfareOriginal,
          benchmarkTotal: null,
          status: finalNoDataStatus,
          basis: integrityStatus === "SUSPICIOUS" ? "Not final: receipt contains unmatched/suspicious flight legs." : "Original purchase/booked currency decision.",
          rateDate: decisionDate,
          rate: 1,
        }),
        decisionCurrencyDecision: buildDecision({
          currency: effectiveDecisionCurrency,
          selectedTotal: convertByRate(airfareOriginal, decisionRate),
          benchmarkTotal: null,
          status: finalNoDataStatus,
          basis: integrityStatus === "SUSPICIOUS" ? "Not final: receipt contains unmatched/suspicious flight legs." : "Selected company decision currency using receipt-date FX rate.",
          rateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
          rate: decisionRate,
        }),
        currencyContext: {
          sourceCurrency,
          decisionCurrency: effectiveDecisionCurrency,
          decisionDate,
          fxRateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
          fxRate: decisionRate,
          fxSource: fx?.source || null,
        },
        receiptIntegrity: Object.assign({}, receiptIntegrity, { sourceCurrency }),
        integrityStatus,
        costAssessmentStatus,
        integrityMessage,
        integrityWarnings,
        assessmentCompleteness: costAssessmentStatus,
        matchedReceiptFlightLegs,
        unmatchedReceiptFlightLegs,
        assessedAirfareSource: round2(assessedAirfareSource),
        unassessedAirfareSource: round2(unassessedAirfareSource),
        benchmarkStrength: "NONE",
        benchmarkMode: "STRICT",
        benchmarkScope: benchmarkScope,
        rationale:
          "The trip was found in local DMO data, but no flight bookings are available to benchmark against the receipt.",
        legGroups: [],
        lines: [],
      };    
    }

    const lineResults = [];
    let selectedTotal = 0;
    let benchmarkTotal = 0;
    let weakestStrength = "HIGH";
    let usedExpanded = false;

    const strengthOrder = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

    // 3) Benchmark each receipt-relevant booking.
    for (const booking of relevantBookings) {
      const connection = await SELECT.one.from("demo.copilot.Connections").where({
        CarrierID: booking.CarrierID,
        ConnectionID: booking.ConnectionID,
      });

      const fromAirport = connection?.AirportFromID ?? null;
      const toAirport = connection?.AirportToID ?? null;
      const bookingCurrency = booking.CurrencyCode ?? travel.CurrencyCode ?? ex.currency ?? r.currency ?? null;
      const selectedPrice = Number(booking.FlightPrice || 0);

      // STRICT benchmark: exact route + exact flight date.
      const strictPrices = (await loadComparableFlightPrices(
        fromAirport,
        toAirport,
        booking.FlightDate
      ))
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);

      let alternatives = strictPrices.map((price) => ({
        carrierId: null,
        connectionId: null,
        flightDate: booking.FlightDate ?? null,
        routeFrom: fromAirport,
        routeTo: toAirport,
        price,
        currency: bookingCurrency,
        scope: "STRICT",
      }));

      let benchmarkMode = "STRICT";

      // EXPANDED fallback: if the strict set is too small, use configured nearby-airport radius/date window.
      if (strictPrices.length < effectiveBenchmarkExpansionThreshold && typeof resolveNearbyAirports === "function") {
        try {
          const [fromNearby, toNearby] = await Promise.all([
            resolveNearbyAirports(fromAirport, effectiveNearbyRadiusKm, { SELECT }),
            resolveNearbyAirports(toAirport, effectiveNearbyRadiusKm, { SELECT }),
          ]);

          const fromAirportIds = normalizeAirportIds(fromAirport, fromNearby);
          const toAirportIds = normalizeAirportIds(toAirport, toNearby);

          const expandedAlternatives = await loadExpandedAlternatives({
            fromAirportIds,
            toAirportIds,
            flightDate: booking.FlightDate,
            bookingCurrency,
            expandedWindowDays: effectiveExpandedWindowDays,
          });

          if (expandedAlternatives.length > strictPrices.length) {
            alternatives = expandedAlternatives;
            benchmarkMode = "EXPANDED";
            usedExpanded = true;
          }
        } catch (e) {
          console.warn("assessCostEfficiency expanded benchmark fallback failed", e?.message || e);
        }
      }

      const bookingContext = {
        fromAirport,
        toAirport,
        flightDate: booking.FlightDate ?? null,
      };

      // Rank alternatives, then use the strongest comparable option as the benchmark.
      const rankedAlternatives = rankAlternatives(alternatives, bookingContext);
      const prices = rankedAlternatives
        .map((a) => Number(a.price))
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);

      const bestAlternative = rankedAlternatives[0] ?? null;
      const benchmarkPrice = bestAlternative ? Number(bestAlternative.price) : null;
      const benchmarkMedianPrice = prices.length ? median(prices) : null;
      const comparableCount = rankedAlternatives.length;
      const benchmarkStrength = getBenchmarkStrength(
        comparableCount,
        benchmarkMode,
        bestAlternative
      );

      const effectiveAcceptableThresholdPercent = toPositiveInt(
        acceptableThresholdPercent,
        DEFAULT_ACCEPTABLE_THRESHOLD_PERCENT
      );

      const selectedPriceDecision = convertByRate(selectedPrice, decisionRate);
      const benchmarkPriceDecision = convertByRate(benchmarkPrice, decisionRate);
      const benchmarkMedianPriceDecision = convertByRate(benchmarkMedianPrice, decisionRate);

      // Apply the same deterministic threshold rule in both currency views.
      const sourceStatus = classifyStatus(selectedPrice, benchmarkPrice, effectiveAcceptableThresholdPercent);
      const decisionStatus = classifyStatus(selectedPriceDecision, benchmarkPriceDecision, effectiveAcceptableThresholdPercent);
      const status = decisionStatus;

      if (strengthOrder[benchmarkStrength] < strengthOrder[weakestStrength]) {
        weakestStrength = benchmarkStrength;
      }

      const namedAlternativesSource = pickNamedAlternatives(
        rankedAlternatives,
        bookingCurrency
      );

      const namedAlternatives = {
        benchmarkAlternative: convertAlternativeToDecisionCurrency(
          namedAlternativesSource.benchmarkAlternative,
          sourceCurrency,
          effectiveDecisionCurrency,
          decisionRate
        ),
        cheapestAlternative: convertAlternativeToDecisionCurrency(
          namedAlternativesSource.cheapestAlternative,
          sourceCurrency,
          effectiveDecisionCurrency,
          decisionRate
        ),
        referenceAlternative: convertAlternativeToDecisionCurrency(
          namedAlternativesSource.referenceAlternative,
          sourceCurrency,
          effectiveDecisionCurrency,
          decisionRate
        ),
        allAlternatives: convertAlternativeListToDecisionCurrency(
          namedAlternativesSource.allAlternatives,
          sourceCurrency,
          effectiveDecisionCurrency,
          decisionRate
        ),
        alternatives: convertAlternativeListToDecisionCurrency(
          namedAlternativesSource.alternatives,
          sourceCurrency,
          effectiveDecisionCurrency,
          decisionRate
        ),
      };

      lineResults.push({
        bookingId: String(booking.BookingID ?? ""),
        carrierId: booking.CarrierID ?? null,
        flightDate: booking.FlightDate ?? null,
        routeFrom: fromAirport,
        routeTo: toAirport,
        sourceCurrency,
        decisionCurrency: effectiveDecisionCurrency,
        selectedPriceSource: round2(selectedPrice),
        benchmarkPriceSource: round2(benchmarkPrice),
        benchmarkMedianPriceSource: round2(benchmarkMedianPrice),
        selectedPrice: round2(selectedPriceDecision),
        benchmarkPrice: round2(benchmarkPriceDecision),
        benchmarkMedianPrice: round2(benchmarkMedianPriceDecision),
        comparableCount,
        benchmarkMode,
        benchmarkStrength,
        sourceStatus,
        decisionStatus,
        status,
        sourceDecision: {
          currency: sourceCurrency,
          selectedPrice: round2(selectedPrice),
          benchmarkPrice: round2(benchmarkPrice),
          status: sourceStatus,
        },
        selectedCurrencyDecision: {
          currency: effectiveDecisionCurrency,
          selectedPrice: round2(selectedPriceDecision),
          benchmarkPrice: round2(benchmarkPriceDecision),
          status: decisionStatus,
          fxRate: decisionRate,
          fxRateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
        },
        rationale: buildLineRationale({
          status,
          benchmarkMode,
          comparableCount,
          bestAlternative,
          bookingContext,
        }),
        bestAlternativeMeta: bestAlternative?.matchMeta || null,
        benchmarkAlternative: namedAlternatives.benchmarkAlternative,
        cheapestAlternative: namedAlternatives.cheapestAlternative,
        referenceAlternative: namedAlternatives.referenceAlternative,
        allAlternatives: namedAlternatives.allAlternatives,
        alternatives: namedAlternatives.alternatives,
      });

      selectedTotal += selectedPrice;
      if (benchmarkPrice != null) benchmarkTotal += benchmarkPrice;
    }

    // 4) Aggregate benchmark results into the overall assessment.
    //    Suspicious receipt integrity blocks a final decision.
    const selectedTotalSource = selectedTotal;
    const benchmarkTotalSource = benchmarkTotal;
    const selectedTotalDecision = convertByRate(selectedTotalSource, decisionRate);
    const benchmarkTotalDecision = convertByRate(benchmarkTotalSource, decisionRate);
    const fullReceiptTotalDecision = convertByRate(fullReceiptTotal, decisionRate);
    const nonAirfareTotalDecision = convertByRate(nonAirfareOriginal, decisionRate);

    const partialSourceOverallStatus = buildOverallStatus(
      lineResults.map((line) => ({ ...line, status: line.sourceStatus }))
    );
    const partialOverallStatus = buildOverallStatus(lineResults);
    const sourceOverallStatus = integrityStatus === "SUSPICIOUS" ? "NOT_ASSESSABLE" : partialSourceOverallStatus;
    const overallStatus = integrityStatus === "SUSPICIOUS" ? "NOT_ASSESSABLE" : partialOverallStatus;
    const benchmarkMode = usedExpanded ? "EXPANDED" : "STRICT";
    const partialRationale = buildAssessmentRationale({ benchmarkMode, lineResults });
    const rationale = integrityStatus === "SUSPICIOUS" ? integrityMessage : partialRationale;

    const partialSourceCurrencyDecision = buildDecision({
      currency: sourceCurrency,
      selectedTotal: selectedTotalSource,
      benchmarkTotal: benchmarkTotalSource,
      status: partialSourceOverallStatus,
      basis: "Partial benchmark for matched/credible flight legs only.",
      rateDate: decisionDate,
      rate: 1,
    });

    const partialDecisionCurrencyDecision = buildDecision({
      currency: effectiveDecisionCurrency,
      selectedTotal: selectedTotalDecision,
      benchmarkTotal: benchmarkTotalDecision,
      status: partialOverallStatus,
      basis: "Partial benchmark for matched/credible flight legs only, converted with receipt-date FX rate.",
      rateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
      rate: decisionRate,
    });

    const sourceCurrencyDecision = buildDecision({
      currency: sourceCurrency,
      selectedTotal: selectedTotalSource,
      benchmarkTotal: benchmarkTotalSource,
      status: sourceOverallStatus,
      basis: integrityStatus === "SUSPICIOUS"
        ? "Not final: receipt contains unmatched/suspicious flight legs. Values are partial for matched legs only."
        : "Original purchase/booked currency decision.",
      rateDate: decisionDate,
      rate: 1,
    });

    const decisionCurrencyDecision = buildDecision({
      currency: effectiveDecisionCurrency,
      selectedTotal: selectedTotalDecision,
      benchmarkTotal: benchmarkTotalDecision,
      status: overallStatus,
      basis: integrityStatus === "SUSPICIOUS"
        ? "Not final: receipt contains unmatched/suspicious flight legs. Values are partial for matched legs only."
        : "Selected company decision currency using receipt-date FX rate.",
      rateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
      rate: decisionRate,
    });

    const cleanedLines = lineResults.map(({ bestAlternativeMeta, ...line }) => line);
    const legGroups = buildLegGroups(cleanedLines);

    // 5) Return UI-ready totals, statuses, integrity, benchmark strength and leg groups.
    const costResult = {
      receiptId,
      travelId: String(travelId),
      bookingCurrency: sourceCurrency,
      sourceCurrency,
      decisionCurrency: effectiveDecisionCurrency,
      selectedTotalSource: round2(selectedTotalSource),
      benchmarkTotalSource: round2(benchmarkTotalSource),
      fullReceiptTotalSource: round2(fullReceiptTotal),
      nonAirfareTotalSource: round2(nonAirfareOriginal),
      selectedTotal: round2(selectedTotalDecision),
      benchmarkTotal: round2(benchmarkTotalDecision),
      fullReceiptTotal: round2(fullReceiptTotalDecision),
      nonAirfareTotal: round2(nonAirfareTotalDecision),
      sourceOverallStatus,
      overallStatus,
      partialSourceOverallStatus,
      partialOverallStatus,
      sourceCurrencyDecision,
      decisionCurrencyDecision,
      partialSourceCurrencyDecision,
      partialDecisionCurrencyDecision,
      receiptIntegrity: Object.assign({}, receiptIntegrity, { sourceCurrency }),
      integrityStatus,
      costAssessmentStatus,
      integrityMessage,
      integrityWarnings,
      assessmentCompleteness: costAssessmentStatus,
      matchedReceiptFlightLegs,
      unmatchedReceiptFlightLegs,
      assessedAirfareSource: round2(assessedAirfareSource),
      unassessedAirfareSource: round2(unassessedAirfareSource),
      currencyContext: {
        sourceCurrency,
        decisionCurrency: effectiveDecisionCurrency,
        decisionDate,
        fxRateDate: fx?.effectiveDate || fx?.rateDate || decisionDate,
        fxRate: decisionRate,
        fxSource: fx?.source || null,
        decisionMeaning:
          "sourceCurrencyDecision shows the purchase-currency view; decisionCurrencyDecision shows the selected company-currency view.",
      },
      benchmarkStrength: weakestStrength,
      benchmarkMode,
      benchmarkScope: benchmarkScope,
      rationale,
      legGroups,
      lines: cleanedLines,
      grouping: {
        basis: "FLIGHT_LEG_PRICE_CURRENCY",
        groupCount: legGroups.length,
        detailLineCount: cleanedLines.length,
        meaning: "The main Cost tab can show legGroups. The detailed lines remain available for raw/debug analysis.",
      },
      bookingSelection: {
        basis: bookingSelection.basis,
        totalDmoBookingCount: bookings.length,
        benchmarkedBookingCount: relevantBookings.length,
        ignoredBookingCount: ignoredBookings.length,
        ignoredBookingIds: ignoredBookings.map((b) => String(b.BookingID ?? "")),
        receiptFlightLegCount: receiptFlightLegs.length,
        matchedReceiptFlightLegCount: matchedReceiptFlightLegs.length,
        unmatchedReceiptFlightLegCount: unmatchedReceiptFlightLegs.length,
        unmatchedReceiptFlightLegs,
      }
    };

    console.log("===========================================================");
    console.log("Cost Efficiency Result === ", JSON.stringify(costResult, null, 2));

    return costResult;
  });
};
