sap.ui.define([
  "demo/copilot/receiptworkbench/controller/Workbench.controller"
], function (_pretty) {
  "use strict";

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function round2(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
  }

  function arrayText(value) {
    if (!Array.isArray(value)) {
      return value == null ? "" : String(value);
    }
    return value.map(function (item) {
      return item == null ? "" : String(item);
    }).filter(Boolean).join(", ");
  }

  function parseMatchResult(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function hasMatchedBooking(leg) {
    return asArray(leg && leg.matchedBookingIds).length > 0;
  }

  function buildMatchStatus(result) {
    if (!result) {
      return { text: "Not matched", state: "None" };
    }

    const warnings = asArray(result.warnings);
    const flightLegs = asArray(result.flightLegMatches);
    const anyUnmatchedLeg = flightLegs.some(function (leg) {
      return !hasMatchedBooking(leg);
    });

    if (anyUnmatchedLeg) {
      return { text: "SUSPICIOUS", state: "Error" };
    }

    if (result.receipt && result.receipt.airfareTotalMatches === false) {
      return { text: "CHECK", state: "Warning" };
    }

    if (warnings.length) {
      return { text: "CHECK", state: "Warning" };
    }

    return { text: "MATCHED", state: "Success" };
  }

  function prepareFlightLeg(leg) {
    const matched = hasMatchedBooking(leg);
    return Object.assign({}, leg, {
      matched: matched,
      statusText: matched ? "Matched" : "No DMO booking",
      statusState: matched ? "Success" : "Error",
      matchedBookingIdsText: arrayText(leg && leg.matchedBookingIds),
      matchedCustomerIdsText: arrayText(leg && leg.matchedCustomerIds),
      flightText: [leg && leg.carrierId, leg && leg.flightNumber].filter(Boolean).join(" "),
      matchedBookingTotalDisplay: round2(leg && leg.matchedBookingTotal),
      farePerPassengerDisplay: round2(leg && leg.farePerPassenger)
    });
  }

  function prepareCustomer(customer) {
    const matched = !!(customer && customer.matched);
    return Object.assign({}, customer, {
      statusText: matched ? "Matched" : "Check",
      statusState: matched ? "Success" : "Warning",
      appearsInBookingsText: customer && customer.appearsInBookings ? "Yes" : "No",
      nameMatchesText: customer && customer.nameMatches === false ? "No" : customer && customer.nameMatches === true ? "Yes" : "-"
    });
  }

  function prepareBooking(booking) {
    return Object.assign({}, booking, {
      flightText: [booking && booking.carrierId, booking && booking.connectionId].filter(Boolean).join(" "),
      bookedFareDisplay: round2(booking && booking.bookedFare),
      receiptFareDisplay: round2(booking && booking.receiptFare),
      catalogFareDisplay: round2(booking && booking.catalogFare),
      catalogNoteState: booking && booking.catalogPriceNote ? "Warning" : "Success",
      catalogNoteText: booking && booking.catalogPriceNote ? booking.catalogPriceNote : "OK"
    });
  }

  function prepareChargeItem(item) {
    return Object.assign({}, item, {
      amountDisplay: round2(item && item.amount)
    });
  }

  return {
    _setMatchResult: function (rawResult) {
      const oUi = this._ui();
      const result = parseMatchResult(rawResult);

      if (!result) {
        oUi.setProperty("/match", null);
        oUi.setProperty("/matchPretty", "");
        oUi.setProperty("/matchHasResult", false);
        oUi.setProperty("/matchNoResult", true);
        oUi.setProperty("/matchStatusText", "Not matched");
        oUi.setProperty("/matchStatusState", "None");
        oUi.setProperty("/matchSummaryText", "");
        return;
      }

      const status = buildMatchStatus(result);
      const receipt = result.receipt || {};
      const travel = result.travel || {};
      const warnings = asArray(result.warnings);
      const preparedFlightLegs = asArray(result.flightLegMatches).map(prepareFlightLeg);
      const preparedCustomers = asArray(result.customers).map(prepareCustomer);
      const preparedBookings = asArray(result.matchedBookings).map(prepareBooking);
      const preparedChargeItems = asArray(result.chargeItems).map(prepareChargeItem);
      const allLegsMatched = preparedFlightLegs.length > 0 && preparedFlightLegs.every(function (leg) { return leg.matched; });

      const prepared = Object.assign({}, result, {
        customers: preparedCustomers,
        flightLegMatches: preparedFlightLegs,
        matchedBookings: preparedBookings,
        chargeItems: preparedChargeItems,
        warnings: warnings,
        travelDataAllLegsMatched: allLegsMatched,
        travelDataAllLegsMatchedText: allLegsMatched ? "All receipt flight legs matched DMO bookings" : "At least one receipt flight leg did not match DMO bookings",
        travelDataAllLegsMatchedState: allLegsMatched ? "Success" : "Error",
        airfareTotalMatchesText: receipt.airfareTotalMatches ? "Airfare totals match" : "Airfare totals differ",
        airfareTotalMatchesState: receipt.airfareTotalMatches ? "Success" : "Warning",
        airfareDifferenceText: round2(receipt.airfareTotalDiff) + " " + (receipt.currency || travel.currency || ""),
        receiptAirfareTotalDisplay: round2(receipt.receiptAirfareTotal),
        dmoMatchedBookedAirfareTotalDisplay: round2(receipt.dmoMatchedBookedAirfareTotal),
        totalAmountDisplay: round2(receipt.totalAmount)
      });

      const summaryText = [
        "Receipt travel " + (receipt.travelId || "-"),
        "DMO travel " + (result.matchedTravelId || travel.travelId || "-"),
        String(receipt.flightLegCount || preparedFlightLegs.length || 0) + " receipt legs",
        String(result.technical && result.technical.matchedDmoBookingCount || preparedBookings.length || 0) + " matched DMO bookings"
      ].join(" · ");

      oUi.setProperty("/match", prepared);
      oUi.setProperty("/matchPretty", this._pretty(result));
      oUi.setProperty("/matchHasResult", true);
      oUi.setProperty("/matchNoResult", false);
      oUi.setProperty("/matchStatusText", status.text);
      oUi.setProperty("/matchStatusState", status.state);
      oUi.setProperty("/matchSummaryText", summaryText);
    },

    formatArrayList: function (value) {
      return arrayText(value);
    },

    formatValueState: function (value) {
      const state = String(value || "").trim();
      const allowed = ["None", "Success", "Warning", "Error", "Information"];

      if (allowed.includes(state)) {
        return state;
      }

      if (/^Indication(0[1-9]|10)$/.test(state)) {
        return state;
      }

      return "None";
    }
  };
});
