sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  return UIComponent.extend("demo.copilot.receiptworkbench.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      console.count("Component init");

      window.addEventListener("error", function (e) {
        console.error("WINDOW ERROR:", e.message, e.filename, e.lineno, e.error);
      });

      window.addEventListener("unhandledrejection", function (e) {
        console.error("PROMISE ERROR:", e.reason);
      });

      UIComponent.prototype.init.apply(this, arguments);

      this.setModel(new JSONModel({

        selectedReceiptId: "",
        selectedReceipt: null,
        busy: false,
        selectedResultTab: "receipt",
        selectedReceiptPretty: "",

        uploadedPretty: "",
        extractedPretty: "",

        matchPretty: "",
        match: "",
        validationPretty: "",

        validation: null,
        validationItems: [],
        validationWarnings: [],
        validationMissing: [],
        validationHasResult: false,
        validationNoResult: true,
        validationHasMissing: false,
        validationHasWarnings: false,
        validationStatusText: "Not validated",
        validationStatusState: "None",
        validationSummaryText: "",
        validationHelpText: "Validation checks whether the extracted receipt data is complete and internally consistent. It checks required fields, dates, currency, total amount, item amounts, and whether the item sum matches the receipt total. It does not check whether the receipt matches travel bookings.",

        selectedTargetCurrency: "EUR",
        currencyOptions: [
          { key: "EUR", text: "EUR" },
          { key: "USD", text: "USD" },
          { key: "GBP", text: "GBP" },
          { key: "CHF", text: "CHF" },
          { key: "JPY", text: "JPY" },
          { key: "CAD", text: "CAD" },
          { key: "AUD", text: "AUD" },
          { key: "SEK", text: "SEK" },
          { key: "NOK", text: "NOK" },
          { key: "DKK", text: "DKK" },
          { key: "PLN", text: "PLN" },
          { key: "CZK", text: "CZK" }
        ],

        recentReceipts: [],
        recentReceiptsLoading: false,
        recentReceiptsError: "",
        pendingRecentReceiptId: "",
        hasEditableReceipt: false,
        noEditableReceipt: true,

        fxResult: null,
        fxPretty: "",
        fxErrorMessage: "",
        fxErrorVisible: false,
        fxErrorTechnical: "",

        postingPretty: "",
        postingErrorMessage: "",

        costFilters: {
          benchmarkExpansionThreshold: 3,
          expandedWindowDays: 2,
          nearbyRadiusKm: 150,
          acceptableThresholdPercent: "10",
          // Cost Efficiency can make two decisions:
          // 1) original source currency decision, e.g. USD
          // 2) selected decision currency decision, e.g. EUR
          decisionCurrency: "EUR",
          acceptableThresholdOptions: [
            { key: "0.1", text: "0.1%" },
            { key: "5", text: "5%" },
            { key: "10", text: "10%" },
            { key: "15", text: "15%" },
            { key: "20", text: "20%" },
            { key: "25", text: "25%" },
            { key: "30", text: "30%" },
            { key: "35", text: "35%" },
            { key: "40", text: "40%" },
            { key: "50", text: "50%" }
          ],
        },

        cost: null,
        costPretty: "",

        opportunityFilters: {
          airportChangePenalty: 30,
          minimumNetSavingAmount: 50,
          minimumNetSavingPercent: 10
        },
        costOpportunity: null,
        costOpportunityPretty: "",
        opportunityBusy: false,

        uploadFileName: "",
        uploadAutoExtract: true,
        uploadBusy: false,
        recentReceiptLimit: 0,
        receiptCount: 0
      }), "ui");
    }
  });
});
