module.exports = function registerMatchDmoHandler(service, deps) {
  // CAP query builders and entities are injected by copilot-service.js.
  const { SELECT, UPDATE, entities } = deps;
  const { Receipts } = entities;

  // Keep airport enrichment limited to fields needed by the match result.
  const AIRPORT_COLUMNS = [
    "AirportID",
    "Ident",
    "Name",
    "City",
    "Country",
    "Latitude",
    "Longitude",
    "ICAOCode",
    "AirportType"
  ];

  const round2 = (value) =>
    value == null ? null : Number(Number(value).toFixed(2));

  // Normalize numeric IDs so leading zeros do not affect matching.
  const normalizeCompareId = (v) => {
    const s = String(v ?? "").trim();
    return /^\d+$/.test(s) ? String(Number(s)) : s;
  };

  // Normalize names for exact comparison independent of case and extra spaces.
  const normalizeName = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  // Build one display name across possible customer field variants.
  const customerDisplayName = (customer) => {
    if (!customer) return "";

    return (
      customer.Name ||
      customer.FullName ||
      [customer.FirstName, customer.LastName].filter(Boolean).join(" ") ||
      [customer.GivenName, customer.FamilyName].filter(Boolean).join(" ") ||
      [customer.Firstname, customer.Lastname].filter(Boolean).join(" ") ||
      [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
      ""
    );
  };

  // Distinguish leg-specific airfare items from summary charge lines.
  const hasFlightSpecificInfo = (item) =>
    !!(
      item &&
      (item.bookingId ||
        item.carrierId ||
        item.flightNumber ||
        item.flightDate ||
        item.dmoConnectionId)
    );

  // Compare extracted flight numbers with available booking/connection identifiers.
  const flightNumberMatches = (receiptFlightNumber, booking) => {
    const receiptNo = normalizeCompareId(receiptFlightNumber);

    if (!receiptNo) return true;

    const candidates = [
      booking?.FlightNumber,
      booking?.FlightNo,
      booking?.ConnectionID
    ]
      .map(normalizeCompareId)
      .filter(Boolean);

    return candidates.length === 0 || candidates.includes(receiptNo);
  };

  service.on("matchDMO", async (req) => {
    const { receiptId } = req.data || {};

    if (!receiptId) {
      return req.reject(400, "receiptId is required");
    }

    const r = await SELECT.one.from(Receipts).where({ ID: receiptId });

    if (!r) {
      return req.reject(404, "Receipt not found");
    }

    let ex = {};

    try {
      ex = r.extractedJson ? JSON.parse(r.extractedJson) : {};
    } catch {
      ex = {};
    }

    const warnings = [];
    const enrichedBookings = [];

    // 1) Prepare the Travel ID.
    const travelIdRaw = String(ex.travelId ?? r.travelId ?? "").trim();

    if (!travelIdRaw) {
      return req.reject(400, "No travelId extracted. Extract first or set travelId.");
    }

    const travelIdNoZeros = travelIdRaw && /^\d+$/.test(travelIdRaw) ? String(Number(travelIdRaw)) : null;

    // 2) Prepare extracted receipt data.
    const items = Array.isArray(ex.items) ? ex.items : [];

    const airfareItems = items.filter(
      (it) => String(it.type || "").toLowerCase() === "airfare"
    );

    const flightLegs = Array.isArray(ex.flightLegs) ? ex.flightLegs : [];

    const extractedCustomers = Array.isArray(ex.customers)
      ? ex.customers
      : Array.isArray(ex.passengers)
        ? ex.passengers.map((p) => ({
            customerId: p.passengerId ?? null,
            name: p.name ?? null,
            role: "Passenger"
          }))
        : [];

    const customerCount = Number(ex.customerCount || ex.passengerCount || extractedCustomers.length || 0);

    const flightLegCount = flightLegs.length;

    // 3) Match the DMO travel and load its bookings.
    let travel = await SELECT.one
      .from("demo.copilot.Travels")
      .where({ TravelID: travelIdRaw });

    if (!travel && travelIdNoZeros) {
      travel = await SELECT.one
        .from("demo.copilot.Travels")
        .where({ TravelID: travelIdNoZeros });
    }

    if (!travel) {
      return req.reject(404, `Travel ${travelIdRaw} not found in local DMO data`);
    }

    const travelCustomer = await SELECT.one
      .from("demo.copilot.Customers")
      .where({ CustomerID: travel.CustomerID });

    if (!travelCustomer) {
      return req.reject(404, `Customer ${travel.CustomerID} not found in local DMO data`);
    }

    const bookings = await SELECT
      .from("demo.copilot.Bookings")
      .where({ TravelID: travel.TravelID });

    const bookingCustomerIds = new Set(
      bookings
        .map((b) => normalizeCompareId(b.CustomerID))
        .filter(Boolean)
    );

    // 4) Match extracted customers against DMO customers.
    let allCustomers = null;
    const customerMatches = [];

    for (const c of extractedCustomers) {
      const customerIdRaw = String(c.customerId || "").trim();
      const nameRaw = String(c.name || "").trim();
      const normalizedCustomerId = normalizeCompareId(customerIdRaw);

      let matchedCustomer = null;
      let matchMethod = null;

      // Prefer CustomerID; fall back to an exact normalized name match.
      if (customerIdRaw) {
        matchedCustomer = await SELECT.one
          .from("demo.copilot.Customers")
          .where({ CustomerID: customerIdRaw });

        if (!matchedCustomer && normalizedCustomerId !== customerIdRaw) {
          matchedCustomer = await SELECT.one
            .from("demo.copilot.Customers")
            .where({ CustomerID: normalizedCustomerId });
        }

        if (matchedCustomer) {
          matchMethod = "CustomerID";
        }
      }

      if (!matchedCustomer && nameRaw) {
        if (!allCustomers) {
          allCustomers = await SELECT.from("demo.copilot.Customers");
        }

        matchedCustomer =
          allCustomers.find((dbCustomer) => {
            const dbName = normalizeName(customerDisplayName(dbCustomer));
            return dbName && dbName === normalizeName(nameRaw);
          }) || null;

        if (matchedCustomer) {
          matchMethod = "Name";
        }
      }

      const dbName = customerDisplayName(matchedCustomer);
      const nameMatches =
        matchedCustomer && nameRaw
          ? normalizeName(dbName) === normalizeName(nameRaw)
          : null;

      const appearsInBookings =
        !!normalizedCustomerId && bookingCustomerIds.has(normalizedCustomerId);

      let warning = null;

      if (!matchedCustomer && !appearsInBookings) {
        warning = `Customer/person "${customerIdRaw || nameRaw || "unknown"}" was not found in DMO Customers or DMO Bookings.`;
      } else if (!matchedCustomer && appearsInBookings) {
        warning = `Customer/person "${customerIdRaw}" was not found in DMO Customers, but appears in DMO Bookings for this travel.`;
      }

      const match = {
        extracted: c,
        matchedCustomer: matchedCustomer || null,
        matched: !!matchedCustomer,
        matchMethod,
        appearsInBookings,
        nameMatches,
        warning
      };

      customerMatches.push(match);

      if (match.warning) {
        warnings.push(match.warning);
      }

      if (match.matchedCustomer && match.nameMatches === false) {
        warnings.push(
          `Customer ${customerIdRaw}: extracted name "${nameRaw}" differs from DMO name "${dbName}".`
        );
      }
    }

    // Restrict booking matches to customers identified on the receipt.
    const receiptCustomerIds = new Set(
      customerMatches
        .flatMap((match) => [
          match.matchedCustomer?.CustomerID,
          match.extracted?.customerId
        ])
        .map(normalizeCompareId)
        .filter(Boolean)
    );

    // 5) Calculate receipt airfare totals used for comparison.
    const receiptAirfareTotal = airfareItems.reduce(
      (sum, item) => sum + (Number(item.amount) || 0),
      0
    );

    const farePerCustomerPerLeg =
      receiptAirfareTotal > 0 && customerCount > 0 && flightLegCount > 0
        ? receiptAirfareTotal / customerCount / flightLegCount
        : null;

    // 6) Enrich bookings with connection, flight and airport data, then match them.
    for (const b of bookings) {
      const connection = await SELECT.one
        .from("demo.copilot.Connections")
        .where({
          CarrierID: b.CarrierID,
          ConnectionID: b.ConnectionID
        });

      const flight = await SELECT.one
        .from("demo.copilot.Flights")
        .where({
          CarrierID: b.CarrierID,
          ConnectionID: b.ConnectionID,
          FlightDate: b.FlightDate
        });

      const fromAirport = connection?.AirportFromID
        ? await SELECT.one
            .from("demo.copilot.Airports")
            .columns(...AIRPORT_COLUMNS)
            .where({ AirportID: connection.AirportFromID })
        : null;

      const toAirport = connection?.AirportToID
        ? await SELECT.one
            .from("demo.copilot.Airports")
            .columns(...AIRPORT_COLUMNS)
            .where({ AirportID: connection.AirportToID })
        : null;

      // Primary match: carrier, date, flight/connection number and route.
      const matchedFlightLeg =
        flightLegs.find((leg) => {
          const sameCarrier =
            String(leg.carrierId || "").toUpperCase() ===
            String(b.CarrierID || "").toUpperCase();

          const sameDate =
            String(leg.flightDate || "") === String(b.FlightDate || "");

          const sameFlightNumber = flightNumberMatches(leg.flightNumber, b);

          const sameRoute =
            !connection ||
            (
              String(leg.fromAirport || "").toUpperCase() ===
                String(connection.AirportFromID || "").toUpperCase() &&
              String(leg.toAirport || "").toUpperCase() ===
                String(connection.AirportToID || "").toUpperCase()
            );

          return sameCarrier && sameDate && sameFlightNumber && sameRoute;
        }) || null;

      // Fallback for older receipts that do not contain structured flight legs.
      const matchedReceiptItem =
        airfareItems.find((it) => {
          const sameBookingId = normalizeCompareId(it.bookingId) === normalizeCompareId(b.BookingID);
          const sameCarrier = String(it.carrierId || "").toUpperCase() === String(b.CarrierID || "").toUpperCase();
          const sameDate = String(it.flightDate || "") === String(b.FlightDate || "");

          return sameBookingId || (sameCarrier && sameDate);
        }) || null;

      // When structured flight legs exist, charge items must not override a failed leg match.
      const allowReceiptItemFallback = flightLegs.length === 0;

      // Do not match bookings for other customers on the same flight.
      const bookingBelongsToReceiptCustomer =
        receiptCustomerIds.size === 0
          ? true
          : receiptCustomerIds.has(normalizeCompareId(b.CustomerID));

      const isMatchedBooking =
        bookingBelongsToReceiptCustomer &&
        (
          !!matchedFlightLeg ||
          (allowReceiptItemFallback && !!matchedReceiptItem)
        );

      const canUseReceiptItemForThisBooking =
        bookingBelongsToReceiptCustomer &&
        (
          !!matchedFlightLeg ||
          allowReceiptItemFallback
        );

      const bookedPrice = Number(b.FlightPrice || 0);
      const catalogPrice = flight?.Price == null ? null : Number(flight.Price || 0);

      // Choose the most reliable receipt price available for this matched booking.
      let receiptPrice = null;
      let receiptPriceBasis = null;

      if (matchedReceiptItem && hasFlightSpecificInfo(matchedReceiptItem) && canUseReceiptItemForThisBooking) {
        receiptPrice = Number(matchedReceiptItem.amount || 0);
        receiptPriceBasis = "specific receipt airfare item";
      } else if (matchedFlightLeg && matchedFlightLeg.farePerPassenger != null) {
        receiptPrice = Number(matchedFlightLeg.farePerPassenger || 0);
        receiptPriceBasis = "flightLeg.farePerPassenger";
      } else if (isMatchedBooking && farePerCustomerPerLeg != null) {
        receiptPrice = farePerCustomerPerLeg;
        receiptPriceBasis = "receipt airfare total / customer count / flight leg count";
      }

      const catalogMinusBooked = catalogPrice == null ? null : catalogPrice - bookedPrice;

      const receiptMinusBooked = receiptPrice == null ? null : receiptPrice - bookedPrice;

      // Catalog-price differences are informational, not blocking warnings.
      const catalogPriceNote =
        catalogMinusBooked != null && Math.abs(catalogMinusBooked) > 0.5
          ? `Catalog price differs from booked fare by ${round2(catalogMinusBooked)}.`
          : null;

      enrichedBookings.push({
        ...b,
        connection,
        flight,
        fromAirport,
        toAirport,
        matchedFlightLeg,
        matchedReceiptItem,
        isMatchedBooking,
        pricing: {
          bookedFare: round2(bookedPrice),
          catalogFare: round2(catalogPrice),
          receiptFare: round2(receiptPrice),
          receiptFareBasis: receiptPriceBasis,
          catalogMinusBooked: round2(catalogMinusBooked),
          receiptMinusBooked: round2(receiptMinusBooked),
          catalogPriceNote,
          pricingContext:
            "bookedFare comes from demo.copilot.Bookings.FlightPrice; catalogFare comes from demo.copilot.Flights.Price. receiptFare is compared using a specific receipt item, flightLeg.farePerPassenger, or receipt airfare total divided by customer count and flight leg count."
        }
      });
    }

    // 7) Compare receipt totals only with bookings that actually matched the receipt.
    const matchedBookings = enrichedBookings.filter((b) => b.isMatchedBooking);
    const unmatchedBookings = enrichedBookings.filter((b) => !b.isMatchedBooking);

    const flightLegMatches = flightLegs.map((leg) => {
      const matchedForLeg = matchedBookings.filter((b) => {
        const m = b.matchedFlightLeg;
        return (
          m &&
          String(m.leg) === String(leg.leg)
        );
      });

      return {
        leg: leg.leg,
        route: leg.route,
        carrierId: leg.carrierId,
        flightNumber: leg.flightNumber,
        flightDate: leg.flightDate,
        farePerPassenger: round2(leg.farePerPassenger),
        currency: leg.currency,
        matchedBookingIds: matchedForLeg.map((b) => b.BookingID),
        matchedCustomerIds: matchedForLeg.map((b) => b.CustomerID),
        matchedBookingTotal: round2(
          matchedForLeg.reduce(
            (sum, b) => sum + (Number(b.FlightPrice) || 0),
            0
          )
        )
      };
    });

    for (const legMatch of flightLegMatches) {
      if (!Array.isArray(legMatch.matchedBookingIds) || legMatch.matchedBookingIds.length === 0) {
        const flightLabel = [legMatch.carrierId, legMatch.flightNumber].filter(Boolean).join(" ") || "unknown flight";
        warnings.push(
          `Receipt flight leg ${legMatch.leg ?? "?"} (${flightLabel}, ${legMatch.flightDate || "unknown date"}, ${legMatch.route || "unknown route"}) was not found in DMO bookings for travel ${travel.TravelID}.`
        );
      }
    }

    const dmoMatchedBookedAirfareTotal = matchedBookings.reduce(
      (sum, booking) => sum + (Number(booking.FlightPrice) || 0),
      0
    );

    const airfareTotalDiff = Math.abs(
      receiptAirfareTotal - dmoMatchedBookedAirfareTotal
    );

    const airfareTotalMatches =
      receiptAirfareTotal > 0 && airfareTotalDiff <= 0.5;

    if (bookings.length > 0 && matchedBookings.length === 0) {
      warnings.push("No DMO bookings matched the extracted receipt flight legs or airfare items.");
    }

    if (receiptAirfareTotal > 0 && !airfareTotalMatches) {
      warnings.push(
        `Receipt airfare total ${receiptAirfareTotal.toFixed(2)} differs from matched DMO booked airfare total ${dmoMatchedBookedAirfareTotal.toFixed(2)}.`
      );
    }

    if (!airfareTotalMatches) {
      for (const b of matchedBookings) {
        const receiptMinusBooked = b.pricing?.receiptMinusBooked;
        const receiptFare = b.pricing?.receiptFare;
        const bookedFare = b.pricing?.bookedFare;

        if (
          receiptMinusBooked != null &&
          Math.abs(receiptMinusBooked) > 0.5
        ) {
          warnings.push(
            `Booking ${b.BookingID}: receipt price ${receiptFare.toFixed(2)} differs from booked price ${bookedFare.toFixed(2)}.`
          );
        }
      }
    }

    // 8) Build a compact result for the SAPUI5 frontend.
    const compactTravelCustomer = travelCustomer
      ? {
          customerId: travelCustomer.CustomerID,
          name: customerDisplayName(travelCustomer),
          title: travelCustomer.Title ?? null,
          email: travelCustomer.EmailAddress ?? null,
          city: travelCustomer.City ?? null,
          countryCode: travelCustomer.CountryCode ?? null
        }
      : null;

    const compactCustomerMatches = customerMatches.map((match) => ({
      extractedCustomerId: match.extracted?.customerId ?? null,
      extractedName: match.extracted?.name ?? null,
      role: match.extracted?.role ?? null,

      dmoCustomerId: match.matchedCustomer?.CustomerID ?? null,
      dmoName: customerDisplayName(match.matchedCustomer),

      matched: match.matched,
      matchMethod: match.matchMethod,
      appearsInBookings: match.appearsInBookings,
      nameMatches: match.nameMatches,
      warning: match.warning
    }));

    const compactChargeItems = items.map((item) => ({
      type: item.type ?? null,
      description: item.description ?? null,
      amount: round2(item.amount),
      currency: item.currency ?? ex.currency ?? null
    }));

    const matchedBookingRows = matchedBookings.map((booking) => ({
      bookingId: booking.BookingID,
      customerId: booking.CustomerID,
      carrierId: booking.CarrierID,
      connectionId: booking.ConnectionID,
      flightDate: booking.FlightDate,
      route: booking.connection
        ? `${booking.connection.AirportFromID} -> ${booking.connection.AirportToID}`
        : null,
      matchedLeg: booking.matchedFlightLeg?.leg ?? null,
      bookedFare: booking.pricing?.bookedFare ?? null,
      receiptFare: booking.pricing?.receiptFare ?? null,
      receiptFareBasis: booking.pricing?.receiptFareBasis ?? null,
      catalogFare: booking.pricing?.catalogFare ?? null,
      catalogPriceNote: booking.pricing?.catalogPriceNote ?? null
    }));

    const result = {
      receipt: {
        id: receiptId,
        travelId: travelIdRaw,
        currency: ex.currency ?? null,
        totalAmount: ex.totalAmount ?? null,
        customerCount,
        flightLegCount,
        receiptAirfareTotal: round2(receiptAirfareTotal),
        dmoMatchedBookedAirfareTotal: round2(dmoMatchedBookedAirfareTotal),
        airfareTotalDiff: round2(airfareTotalDiff),
        airfareTotalMatches,
        farePerCustomerPerLeg: round2(farePerCustomerPerLeg)
      },

      matchedTravelId: travel.TravelID,

      travel: {
        travelId: travel.TravelID,
        agencyId: travel.AgencyID ?? null,
        customerId: travel.CustomerID ?? null,
        beginDate: travel.BeginDate ?? null,
        endDate: travel.EndDate ?? null,
        bookingFee: round2(travel.BookingFee),
        totalPrice: round2(travel.TotalPrice),
        currency: travel.CurrencyCode ?? null,
        description: travel.Description ?? null,
        status: travel.Status ?? null
      },

      travelCustomer: compactTravelCustomer,
      customers: compactCustomerMatches,
      flightLegMatches,
      chargeItems: compactChargeItems,
      matchedBookings: matchedBookingRows,
      warnings,

      technical: {
        receiptCustomerIds: Array.from(receiptCustomerIds),
        allDmoBookingCount: bookings.length,
        matchedDmoBookingCount: matchedBookings.length,
        unmatchedDmoBookingCount: unmatchedBookings.length,
        unmatchedDmoBookingIds: unmatchedBookings.map((b) => b.BookingID)
      }
    };

    console.log("Match DMO/Travel Data result:", JSON.stringify(result, null, 2));
    console.log("======================================");

    // Persist the workflow state after a successful match.
    await UPDATE(Receipts)
      .set({ status: "MATCHED" })
      .where({ ID: receiptId });

    return JSON.stringify(result, null, 2);
  });
};
