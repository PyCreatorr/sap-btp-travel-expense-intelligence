module.exports = function registerCheaperOpportunitiesHandler(service, deps) {
  const { SELECT, entities, adapters } = deps;
  const { Receipts } = entities;
  const { loadTravelAndBookings, resolveNearbyAirports } = adapters;

  const DEFAULT_RADIUS_KM = 50;
  const DEFAULT_WINDOW_DAYS = 0;
  const DEFAULT_AIRPORT_CHANGE_PENALTY = 30;
  const DEFAULT_MIN_NET_SAVING_AMOUNT = 50;
  const DEFAULT_MIN_NET_SAVING_PERCENT = 10;
  const MAX_ALTERNATIVES_PER_LEG = 20;

  const round2 = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Number(Number(value).toFixed(2));

  const round5 = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Number(Number(value).toFixed(5));

  const roundCoordinate = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Number(Number(value).toFixed(6));

  const toPositiveNumber = (value, fallbackValue) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallbackValue;
  };

  const toNonNegativeNumber = (value, fallbackValue) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallbackValue;
  };

  const normalizeId = (value) => {
    const text = String(value ?? "").trim();
    return /^\d+$/.test(text)
      ? String(Number(text))
      : text.toUpperCase();
  };

  const normalizeAirport = (value) => String(value || "").trim().toUpperCase();
  const normalizeDate = (value) => value ? String(value).slice(0, 10) : "";

  const normalizeCurrency = (value) => {
    const text = String(value || "").trim().toUpperCase();
    return /^[A-Z]{3}$/.test(text) ? text : null;
  };

  const addDays = (isoDate, offset) => {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };

  const diffDays = (dateA, dateB) => {
    if (!dateA || !dateB) return 99;
    const first = new Date(`${dateA}T00:00:00Z`);
    const second = new Date(`${dateB}T00:00:00Z`);
    return Math.round(Math.abs(first - second) / 86400000);
  };

  const convertByRate = (amount, rate) => {
    const number = Number(amount);
    return Number.isFinite(number) ? round2(number * Number(rate || 1)) : null;
  };

  const getReceiptFlightLegs = (extracted) =>
    Array.isArray(extracted?.flightLegs) ? extracted.flightLegs : [];

  const getExtractedCustomerIds = (extracted) => {
    const customers = Array.isArray(extracted?.customers)
      ? extracted.customers
      : Array.isArray(extracted?.passengers)
        ? extracted.passengers
        : [];

    return new Set(
      customers
        .map((customer) => normalizeId(customer?.customerId ?? customer?.passengerId))
        .filter(Boolean)
    );
  };

  service.on("checkCheaperOpportunities", async (req) => {
    const {
      receiptId,
      nearbyRadiusKm,
      expandedWindowDays,
      decisionCurrency,
      airportChangePenalty,
      minimumNetSavingAmount,
      minimumNetSavingPercent,
    } = req.data || {};

    if (!receiptId) return req.reject(400, "receiptId is required");

    const receipt = await SELECT.one.from(Receipts).where({ ID: receiptId });
    if (!receipt) return req.reject(404, "Receipt not found");
    if (!receipt.extractedJson) return req.reject(400, "Extract first");

    let extracted;
    try {
      extracted = JSON.parse(receipt.extractedJson);
    } catch (error) {
      return req.reject(400, "Extracted JSON is invalid");
    }

    const travelId = extracted.travelId ?? receipt.travelId;
    if (!travelId) {
      return req.reject(400, "No travelId available. Extract first or set travelId.");
    }

    const { travel, bookings } = await loadTravelAndBookings(travelId);
    if (!travel) {
      return req.reject(404, `Travel ${travelId} not found in local DMO data`);
    }

    const radiusKm = toPositiveNumber(nearbyRadiusKm, DEFAULT_RADIUS_KM);
    const windowDays = Math.floor(toNonNegativeNumber(expandedWindowDays, DEFAULT_WINDOW_DAYS));
    const penaltyPerChangedAirport = toNonNegativeNumber(
      airportChangePenalty,
      DEFAULT_AIRPORT_CHANGE_PENALTY
    );
    const minNetSavingAmount = toNonNegativeNumber(
      minimumNetSavingAmount,
      DEFAULT_MIN_NET_SAVING_AMOUNT
    );
    const minNetSavingPercent = toNonNegativeNumber(
      minimumNetSavingPercent,
      DEFAULT_MIN_NET_SAVING_PERCENT
    );

    const warnings = [];
    const sourceCurrency =
      normalizeCurrency(travel.CurrencyCode) ||
      normalizeCurrency(extracted.currency) ||
      normalizeCurrency(receipt.currency);

    let effectiveDecisionCurrency = normalizeCurrency(decisionCurrency) || sourceCurrency;
    let decisionRate = 1;
    let fxRateDate = extracted.receiptDate ?? receipt.receiptDate ?? null;
    let fxSource = "identity";

    if (
      sourceCurrency &&
      effectiveDecisionCurrency &&
      sourceCurrency !== effectiveDecisionCurrency
    ) {
      try {
        const fx = await service.send("convertFx", {
          receiptId,
          toCurrency: effectiveDecisionCurrency,
        });
        decisionRate = Number(fx?.rate || 1);
        fxRateDate = fx?.effectiveDate || fx?.rateDate || fxRateDate;
        fxSource = fx?.source || null;
      } catch (error) {
        warnings.push({
          text: `FX conversion to ${effectiveDecisionCurrency} failed. Opportunity values are shown in ${sourceCurrency || "the source currency"}.`,
        });
        effectiveDecisionCurrency = sourceCurrency;
        decisionRate = 1;
        fxSource = "identity-after-fx-error";
      }
    }

    const connectionCache = new Map();
    const loadConnection = async (booking) => {
      const key = `${booking?.CarrierID || ""}::${booking?.ConnectionID || ""}`;
      if (connectionCache.has(key)) return connectionCache.get(key);

      const connection = await SELECT.one
        .from("demo.copilot.Connections")
        .where({
          CarrierID: booking.CarrierID,
          ConnectionID: booking.ConnectionID,
        });

      connectionCache.set(key, connection || null);
      return connection || null;
    };

    const bookingMatchesLeg = async (booking, leg) => {
      const connection = await loadConnection(booking);

      const sameCarrier =
        normalizeId(booking.CarrierID) === normalizeId(leg?.carrierId);
      const sameConnection =
        normalizeId(booking.ConnectionID) ===
        normalizeId(leg?.flightNumber || leg?.connectionId);
      const sameDate =
        normalizeDate(booking.FlightDate) === normalizeDate(leg?.flightDate);

      const legFrom = normalizeAirport(leg?.fromAirport || leg?.routeFrom);
      const legTo = normalizeAirport(leg?.toAirport || leg?.routeTo);
      const bookingFrom = normalizeAirport(connection?.AirportFromID);
      const bookingTo = normalizeAirport(connection?.AirportToID);

      const sameRoute =
        (!legFrom || bookingFrom === legFrom) &&
        (!legTo || bookingTo === legTo);

      return sameCarrier && sameConnection && sameDate && sameRoute;
    };

    const flightLegs = getReceiptFlightLegs(extracted);
    const extractedCustomerIds = getExtractedCustomerIds(extracted);
    const restrictToExtractedCustomers = extractedCustomerIds.size > 0;

    const legEntries = flightLegs.map((leg, index) => ({
      leg,
      index,
      bookings: [],
    }));

    const eligibleBookings = [];
    const ignoredCustomerBookings = [];

    for (const booking of bookings || []) {
      const bookingCustomerId = normalizeId(booking.CustomerID);
      if (
        restrictToExtractedCustomers &&
        bookingCustomerId &&
        !extractedCustomerIds.has(bookingCustomerId)
      ) {
        ignoredCustomerBookings.push(booking);
        continue;
      }

      if (!flightLegs.length) {
        eligibleBookings.push({ booking, legIndex: null });
        continue;
      }

      let matchedLegIndex = null;
      for (let index = 0; index < flightLegs.length; index += 1) {
        if (await bookingMatchesLeg(booking, flightLegs[index])) {
          matchedLegIndex = index;
          break;
        }
      }

      if (matchedLegIndex != null) {
        legEntries[matchedLegIndex].bookings.push(booking);
        eligibleBookings.push({ booking, legIndex: matchedLegIndex });
      }
    }

    const unmatchedReceiptLegs = legEntries
      .filter((entry) => entry.bookings.length === 0)
      .map((entry) => ({
        legNumber: entry.leg?.leg ?? entry.index + 1,
        carrierId: entry.leg?.carrierId ?? null,
        flightNumber: entry.leg?.flightNumber ?? entry.leg?.connectionId ?? null,
        flightDate: entry.leg?.flightDate ?? null,
        routeFrom: entry.leg?.fromAirport ?? entry.leg?.routeFrom ?? null,
        routeTo: entry.leg?.toAirport ?? entry.leg?.routeTo ?? null,
      }));

    if (unmatchedReceiptLegs.length) {
      warnings.push({
        text: `${unmatchedReceiptLegs.length} receipt flight leg(s) were not found in the DMO bookings. The opportunity check covers matched legs only.`,
      });
    }

    if (ignoredCustomerBookings.length) {
      warnings.push({
        text: `${ignoredCustomerBookings.length} DMO booking row(s) belonging to other travel customers were excluded.`,
      });
    }

    const groupedBookings = new Map();

    for (const selected of eligibleBookings) {
      const booking = selected.booking;
      const connection = await loadConnection(booking);
      if (!connection) continue;

      const key = [
        booking.CarrierID,
        booking.ConnectionID,
        normalizeDate(booking.FlightDate),
        connection.AirportFromID,
        connection.AirportToID,
        booking.CurrencyCode || travel.CurrencyCode || sourceCurrency,
      ].join("::");

      const existing = groupedBookings.get(key);
      const bookedFare = Number(booking.FlightPrice || 0);

      if (!existing) {
        groupedBookings.set(key, {
          legIndex: selected.legIndex,
          carrierId: booking.CarrierID ?? null,
          connectionId: booking.ConnectionID ?? null,
          flightDate: normalizeDate(booking.FlightDate),
          routeFrom: connection.AirportFromID ?? null,
          routeTo: connection.AirportToID ?? null,
          sourceCurrency: booking.CurrencyCode || travel.CurrencyCode || sourceCurrency,
          passengerCount: 1,
          bookingIds: [String(booking.BookingID ?? "")].filter(Boolean),
          selectedTotalSource: bookedFare,
        });
      } else {
        existing.passengerCount += 1;
        if (booking.BookingID != null) {
          existing.bookingIds.push(String(booking.BookingID));
        }
        existing.selectedTotalSource += bookedFare;
      }
    }

    const groupedLegs = [...groupedBookings.values()].sort((first, second) => {
      const firstIndex = first.legIndex == null ? 9999 : first.legIndex;
      const secondIndex = second.legIndex == null ? 9999 : second.legIndex;
      if (firstIndex !== secondIndex) return firstIndex - secondIndex;
      return String(first.flightDate).localeCompare(String(second.flightDate));
    });

    const [allConnections, allFlights] = await Promise.all([
      SELECT.from("demo.copilot.Connections"),
      SELECT.from("demo.copilot.Flights"),
    ]);

    const connectionMap = new Map(
      allConnections.map((connection) => [
        `${connection.CarrierID}::${connection.ConnectionID}`,
        connection,
      ])
    );

    const connectedOriginAirportIds = new Set(
      allConnections.map((connection) => normalizeAirport(connection.AirportFromID)).filter(Boolean)
    );
    const connectedDestinationAirportIds = new Set(
      allConnections.map((connection) => normalizeAirport(connection.AirportToID)).filter(Boolean)
    );

    const keepCommerciallyUsableNearbyAirports = (result, role) => {
      if (!result) return null;
      const connectedIds = role === "ORIGIN"
        ? connectedOriginAirportIds
        : connectedDestinationAirportIds;

      return {
        ...result,
        nearbyAirports: (result.nearbyAirports || []).filter((airport) =>
          connectedIds.has(normalizeAirport(airport.airportId || airport.iata))
        ),
      };
    };

    const nearbyCache = new Map();
    const getNearby = async (airportId) => {
      const normalized = normalizeAirport(airportId);
      if (!normalized) return null;
      if (nearbyCache.has(normalized)) return nearbyCache.get(normalized);

      try {
        const result = await resolveNearbyAirports(normalized, radiusKm, { SELECT });
        nearbyCache.set(normalized, result);
        return result;
      } catch (error) {
        warnings.push({
          text: `Nearby-airport lookup failed for ${normalized}: ${error?.message || error}`,
        });
        nearbyCache.set(normalized, null);
        return null;
      }
    };

    const nearbyAirportRows = [];
    const nearbyAirportRowKeys = new Set();
    const opportunityLegs = [];
    let searchedCandidateCount = 0;

    const addNearbyRows = (role, result) => {
      if (!result) return;
      for (const airport of result.nearbyAirports || []) {
        const key = `${role}::${result.sourceAirportId}::${airport.airportId}`;
        if (nearbyAirportRowKeys.has(key)) continue;
        nearbyAirportRowKeys.add(key);
        nearbyAirportRows.push({
          role,
          sourceAirportId: result.sourceAirportId,
          sourceLatitude: roundCoordinate(result.center?.lat),
          sourceLongitude: roundCoordinate(result.center?.lon),
          airportId: airport.airportId || airport.iata || null,
          name: airport.name ?? null,
          city: airport.city ?? null,
          country: airport.country ?? null,
          latitude: roundCoordinate(airport.lat),
          longitude: roundCoordinate(airport.lon),
          distanceKm: round2(airport.distanceKm),
        });
      }
    };

    for (let groupIndex = 0; groupIndex < groupedLegs.length; groupIndex += 1) {
      const group = groupedLegs[groupIndex];
      const originNearby = keepCommerciallyUsableNearbyAirports(
        await getNearby(group.routeFrom),
        "ORIGIN"
      );
      const destinationNearby = keepCommerciallyUsableNearbyAirports(
        await getNearby(group.routeTo),
        "DESTINATION"
      );

      addNearbyRows("ORIGIN", originNearby);
      addNearbyRows("DESTINATION", destinationNearby);

      const originDistanceMap = new Map(
        (originNearby?.nearbyAirports || []).map((airport) => [
          normalizeAirport(airport.airportId || airport.iata),
          Number(airport.distanceKm || 0),
        ])
      );
      const destinationDistanceMap = new Map(
        (destinationNearby?.nearbyAirports || []).map((airport) => [
          normalizeAirport(airport.airportId || airport.iata),
          Number(airport.distanceKm || 0),
        ])
      );

      const originIds = new Set([
        normalizeAirport(group.routeFrom),
        ...originDistanceMap.keys(),
      ]);
      const destinationIds = new Set([
        normalizeAirport(group.routeTo),
        ...destinationDistanceMap.keys(),
      ]);

      const startDate = addDays(group.flightDate, -windowDays);
      const endDate = addDays(group.flightDate, windowDays);

      const eligibleConnections = allConnections.filter((connection) => {
        const routeFrom = normalizeAirport(connection.AirportFromID);
        const routeTo = normalizeAirport(connection.AirportToID);
        const isOriginalRoute =
          routeFrom === normalizeAirport(group.routeFrom) &&
          routeTo === normalizeAirport(group.routeTo);

        return (
          originIds.has(routeFrom) &&
          destinationIds.has(routeTo) &&
          routeFrom !== routeTo &&
          !isOriginalRoute
        );
      });

      const eligibleConnectionKeys = new Set(
        eligibleConnections.map((connection) =>
          `${connection.CarrierID}::${connection.ConnectionID}`
        )
      );

      const selectedTotalDecision = convertByRate(
        group.selectedTotalSource,
        decisionRate
      );

      const alternatives = [];
      const seenAlternatives = new Set();

      for (const flight of allFlights) {
        const connectionKey = `${flight.CarrierID}::${flight.ConnectionID}`;
        if (!eligibleConnectionKeys.has(connectionKey)) continue;

        const flightDate = normalizeDate(flight.FlightDate);
        if (flightDate < startDate || flightDate > endDate) continue;

        const flightCurrency = normalizeCurrency(flight.CurrencyCode) || group.sourceCurrency;
        if (
          sourceCurrency &&
          flightCurrency &&
          normalizeCurrency(flightCurrency) !== normalizeCurrency(sourceCurrency)
        ) {
          continue;
        }

        const connection = connectionMap.get(connectionKey);
        if (!connection) continue;

        const priceSource = Number(flight.Price || 0);
        if (!Number.isFinite(priceSource) || priceSource <= 0) continue;

        const alternativeKey = `${connectionKey}::${flightDate}`;
        if (seenAlternatives.has(alternativeKey)) continue;
        seenAlternatives.add(alternativeKey);

        const routeFrom = normalizeAirport(connection.AirportFromID);
        const routeTo = normalizeAirport(connection.AirportToID);
        const originChanged = routeFrom !== normalizeAirport(group.routeFrom);
        const destinationChanged = routeTo !== normalizeAirport(group.routeTo);
        const airportChanges = Number(originChanged) + Number(destinationChanged);
        const originDistanceKm = originChanged
          ? round2(originDistanceMap.get(routeFrom))
          : 0;
        const destinationDistanceKm = destinationChanged
          ? round2(destinationDistanceMap.get(routeTo))
          : 0;

        const flightTotalSource = round2(priceSource * group.passengerCount);
        const flightTotal = convertByRate(flightTotalSource, decisionRate);
        const estimatedExtraCost = round2(
          penaltyPerChangedAirport * airportChanges * group.passengerCount
        );
        const adjustedTotal = round2(
          Number(flightTotal || 0) + Number(estimatedExtraCost || 0)
        );
        const grossSaving = round2(
          Number(selectedTotalDecision || 0) - Number(flightTotal || 0)
        );
        const netSaving = round2(
          Number(selectedTotalDecision || 0) - Number(adjustedTotal || 0)
        );
        const netSavingPercent = selectedTotalDecision > 0
          ? round2((Number(netSaving || 0) / Number(selectedTotalDecision)) * 100)
          : null;

        alternatives.push({
          carrierId: flight.CarrierID ?? null,
          connectionId: flight.ConnectionID ?? null,
          flightDate,
          routeFrom,
          routeTo,
          sourceCurrency,
          decisionCurrency: effectiveDecisionCurrency,
          pricePerPassengerSource: round2(priceSource),
          pricePerPassenger: convertByRate(priceSource, decisionRate),
          passengerCount: group.passengerCount,
          flightTotalSource,
          flightTotal,
          airportChanges,
          originChanged,
          destinationChanged,
          originDistanceKm,
          destinationDistanceKm,
          estimatedExtraCost,
          adjustedTotal,
          grossSaving,
          netSaving,
          netSavingPercent,
          dateOffsetDays: diffDays(flightDate, group.flightDate),
          scope: "NEARBY_AIRPORT_ONLY",
        });
      }

      alternatives.sort((first, second) => {
        if (Number(first.adjustedTotal) !== Number(second.adjustedTotal)) {
          return Number(first.adjustedTotal) - Number(second.adjustedTotal);
        }
        if (first.dateOffsetDays !== second.dateOffsetDays) {
          return first.dateOffsetDays - second.dateOffsetDays;
        }
        if (first.airportChanges !== second.airportChanges) {
          return first.airportChanges - second.airportChanges;
        }
        return Number(first.flightTotal) - Number(second.flightTotal);
      });

      searchedCandidateCount += alternatives.length;
      const bestAlternative = alternatives[0] || null;

      let status = "NO_ALTERNATIVES";
      let message =
        "No flight using a different nearby-airport route was found in the selected radius and date window.";

      if (
        !originDistanceMap.size &&
        !destinationDistanceMap.size
      ) {
        status = "NO_NEARBY_AIRPORTS";
        message = `No nearby airports with GPS coordinates were found within ${radiusKm} km of this route.`;
      } else if (bestAlternative) {
        const material =
          Number(bestAlternative.netSaving) >= minNetSavingAmount &&
          Number(bestAlternative.netSavingPercent) >= minNetSavingPercent;

        if (material) {
          status = "MATERIAL_OPPORTUNITY";
          message =
            "A materially cheaper nearby-airport route was found after the configured airport-change allowance.";
        } else if (Number(bestAlternative.netSaving) > 0) {
          status = "SMALL_DIFFERENCE";
          message =
            "A cheaper nearby-airport route was found, but the estimated net advantage is below the materiality thresholds.";
        } else {
          status = "NO_NET_SAVING";
          message =
            "Nearby-airport routes were found, but none remained cheaper after the configured airport-change allowance.";
        }
      }

      opportunityLegs.push({
        legKey: `leg-${groupIndex + 1}`,
        legNumber: group.legIndex == null ? groupIndex + 1 : group.legIndex + 1,
        bookingIdsText: group.bookingIds.join(", "),
        originalCarrierId: group.carrierId,
        originalConnectionId: group.connectionId,
        flightDate: group.flightDate,
        originalRouteFrom: group.routeFrom,
        originalRouteTo: group.routeTo,
        passengerCount: group.passengerCount,
        sourceCurrency,
        decisionCurrency: effectiveDecisionCurrency,
        selectedTotalSource: round2(group.selectedTotalSource),
        selectedTotal: round2(selectedTotalDecision),
        nearbyOriginCount: originDistanceMap.size,
        nearbyDestinationCount: destinationDistanceMap.size,
        alternativeCount: alternatives.length,
        status,
        message,
        bestAlternative,
        alternatives: alternatives.slice(0, MAX_ALTERNATIVES_PER_LEG),
      });
    }

    const materialOpportunityCount = opportunityLegs.filter(
      (leg) => leg.status === "MATERIAL_OPPORTUNITY"
    ).length;
    const positiveOpportunityCount = opportunityLegs.filter(
      (leg) =>
        leg.status === "MATERIAL_OPPORTUNITY" ||
        leg.status === "SMALL_DIFFERENCE"
    ).length;

    let overallStatus = "INSUFFICIENT_DATA";
    if (materialOpportunityCount > 0) {
      overallStatus = "MATERIAL_OPPORTUNITY";
    } else if (positiveOpportunityCount > 0) {
      overallStatus = "POTENTIAL_ONLY";
    } else if (opportunityLegs.length > 0) {
      overallStatus = "NO_MATERIAL_OPPORTUNITY";
    }

    const assessmentCompleteness = unmatchedReceiptLegs.length
      ? "PARTIAL_ONLY"
      : flightLegs.length
        ? "FULL"
        : "UNVERIFIED";

    const overallMessage = overallStatus === "MATERIAL_OPPORTUNITY"
      ? "At least one matched flight leg has a materially cheaper nearby-airport route in the available DMO catalog. This is supporting evidence only and does not replace the main commercial decision."
      : overallStatus === "POTENTIAL_ONLY"
        ? "Cheaper nearby-airport routes were found, but their estimated net advantage is below the configured materiality thresholds."
        : overallStatus === "NO_MATERIAL_OPPORTUNITY"
          ? "No materially cheaper nearby-airport route was found after applying the configured airport-change allowance."
          : "There was not enough matched booking and nearby-airport data to calculate an opportunity result.";

    return {
      receiptId,
      travelId: String(travelId),
      sourceCurrency,
      decisionCurrency: effectiveDecisionCurrency,
      overallStatus,
      assessmentCompleteness,
      mainDecisionImpact: "NONE",
      mainDecisionMessage:
        "This opportunity explorer is advisory. It never changes the GOOD, ACCEPTABLE, REVIEW, or NOT_ASSESSABLE result produced by the main Cost Efficiency assessment.",
      overallMessage,
      evidenceLimit:
        "The result uses the available local DMO flight catalog. Unless historical offer snapshots are stored, it does not prove which alternative was actually available at the original booking time.",
      radiusKm: round2(radiusKm),
      expandedWindowDays: windowDays,
      airportChangePenalty: round2(penaltyPerChangedAirport),
      minimumNetSavingAmount: round2(minNetSavingAmount),
      minimumNetSavingPercent: round2(minNetSavingPercent),
      checkedLegCount: opportunityLegs.length,
      materialOpportunityCount,
      positiveOpportunityCount,
      nearbyAirportCount: nearbyAirportRows.length,
      searchedCandidateCount,
      passengerSelectionBasis: restrictToExtractedCustomers
        ? "EXTRACTED_RECEIPT_CUSTOMERS"
        : "ALL_MATCHED_TRAVEL_BOOKINGS",
      fxRate: round5(decisionRate),
      fxRateDate,
      fxSource,
      nearbyAirports: nearbyAirportRows,
      legs: opportunityLegs,
      warnings,
    };
  });
};
