sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/base/Log",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "demo/copilot/receiptworkbench/service/CopilotApi",
  "demo/copilot/receiptworkbench/controller/parts/UploadReceipt",
  "demo/copilot/receiptworkbench/controller/parts/CostAssessment",
  "demo/copilot/receiptworkbench/controller/parts/Validation",
  "demo/copilot/receiptworkbench/controller/parts/MatchDmo"
], function (Controller, Fragment, Log, MessageBox, MessageToast, CopilotApi, UploadReceipt, CostAssessment, Validation, MatchDmo) {
  "use strict";

  function normalizeCurrency(value) {
    return String(value || "").trim().toUpperCase();
  }

  function getErrorText(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    return String(error);
  }

  function parsePostingResult(value) {
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

  function round2Display(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
  }

  function buildPostingStatus(result) {
    if (!result) {
      return { text: "Not generated", state: "None" };
    }

    const lines = Array.isArray(result.lines) ? result.lines : [];
    const originalDiff = Math.abs(Number(result.totalDifferenceOriginal || 0));
    const postingDiff = Math.abs(Number(result.totalDifferencePosting || 0));

    if (!lines.length) {
      return { text: "CHECK", state: "Warning" };
    }

    if (originalDiff > 0.5 || postingDiff > 0.5) {
      return { text: "CHECK BALANCE", state: "Warning" };
    }

    return { text: "DRAFT READY", state: "Success" };
  }

  function preparePostingLine(line, currencyOriginal, postingCurrency) {
    const suggestion = line && line.postingSuggestion || {};
    const isAirfare = String(line && line.lineCategory || "").toUpperCase() === "AIRFARE";

    return Object.assign({}, line, {
      currencyOriginal: currencyOriginal || line.currency || null,
      postingCurrency: postingCurrency || line.postingCurrency || null,
      amountOriginalDisplay: round2Display(line && line.amountOriginal),
      amountPostingDisplay: round2Display(line && line.amountPosting),
      categoryText: isAirfare ? "Airfare" : "Non-Airfare",
      categoryState: isAirfare ? "Information" : "None",
      suggestedCategory: suggestion.suggestedCategory || "",
      suggestedAccount: suggestion.suggestedAccount || "",
      suggestionReason: suggestion.reason || ""
    });
  }


  return Controller.extend("demo.copilot.receiptworkbench.controller.Workbench",  Object.assign({
    onInit: function () {
      this._setMatchResult(null);
      this._setPostingProposalResult(null);
      this._loadRecentReceipts();
    },

    _ui: function () {
      return this.getView().getModel("ui");
    },

    _pretty: function (value) {
      if (value == null) return "";
      if (typeof value === "string") return value;
      return JSON.stringify(value, null, 2);
    },

    _clone: function (value) {
      if (value == null) {
        return null;
      }
    
      return JSON.parse(JSON.stringify(value));
    },
    
    _parseExtractedJson: function (value) {
      if (!value) {
        return null;
      }
    
      if (typeof value === "object") {
        return value;
      }
    
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch (e) {
          console.warn("extractedJson is not valid JSON string:", value);
          return null;
        }
      }
    
      return null;
    },
    
    _setSelectedReceiptForEditing: function (receipt) {
      const oUi = this._ui();

      // 1. No receipt selected
      if (!receipt) {
        oUi.setProperty("/selectedReceiptId", "");
        oUi.setProperty("/selectedReceipt", "");
        oUi.setProperty("/originalExtractedReceipt", null);
        oUi.setProperty("/editableReceipt", null);

        oUi.setProperty("/hasEditableReceipt", false);
        oUi.setProperty("/noEditableReceipt", true);
        return;
      }

      // A receipt IS selected
      oUi.setProperty("/selectedReceiptId", receipt.ID);
      oUi.setProperty("/noEditableReceipt", false);

      // 2. Receipt selected, but not extracted
      if (!receipt.extractedJson) {
        oUi.setProperty("/selectedReceipt", "");
        oUi.setProperty("/originalExtractedReceipt", null);
        oUi.setProperty("/editableReceipt", null);
        oUi.setProperty("/hasEditableReceipt", false);
        return;
      }

      // 3. Receipt selected and extracted
      const extracted = this._parseExtractedJson(receipt.extractedJson) || {};

      if (!Array.isArray(extracted.items)) {
        extracted.items = [];
      }

      oUi.setProperty("/selectedReceipt", this._pretty(extracted));
      oUi.setProperty("/originalExtractedReceipt", this._clone(extracted));
      oUi.setProperty("/editableReceipt", this._clone(extracted));

      oUi.setProperty("/hasEditableReceipt", true);
      oUi.setProperty("/noEditableReceipt", false);
    },

    _loadRecentReceipts: async function (preferredReceiptId) {
      const oUi = this._ui();

      // console.log("oUi=", oUi);
    
      oUi.setProperty("/recentReceiptsLoading", true);
      oUi.setProperty("/recentReceiptsError", "");
      oUi.setProperty("/selectedResultTab", "receipt");
      oUi.setProperty("/receiptCount", "");
    
      try {
        const count = await CopilotApi.countReceipts();
        console.log("Total receipts:", count);        

        // oUi._ui().setProperty("/recentReceipts", receipts || []);
        // oUi._ui().setProperty("/receiptCount", (receipts || []).length);

        // console.log("ui model object:", oUi);      // only if you want to inspect the JSONModel itself
        // console.log("ui model data:", oUi.getData()); // if you want to see your actual stored values

        // expose model globally for debugging
        window.uiModel = this.getView().getModel("ui");
        window.uiData = this.getView().getModel("ui").getData();


        const receipts = await CopilotApi.listReceipts(count);
        const aReceipts = receipts || [];


        // oUi.setProperty("/receiptCount", count);
        oUi.setProperty(
          "/receiptsTitle",
          "Showing " + count + " Receipts"
        );
    
        oUi.setProperty("/recentReceipts", aReceipts);
    
        if (aReceipts.length > 0) {
          const firstReceipt = aReceipts[0];
    
          // oUi.setProperty("/selectedReceiptId", firstReceipt.ID);
          // oUi.setProperty("/selectedReceipt", this._pretty(firstReceipt.extractedJson));

          this._setSelectedReceiptForEditing(firstReceipt);


          oUi.setProperty("/pendingRecentReceiptId", firstReceipt.ID);
          oUi.setProperty("/selectedResultTab", "receipt");
        } else {
          oUi.setProperty("/selectedReceiptId", "");
          oUi.setProperty("/selectedReceipt", "");
          oUi.setProperty("/pendingRecentReceiptId", "");
        }
    
      } catch (e) {
        oUi.setProperty("/recentReceipts", []);
        oUi.setProperty("/selectedReceiptId", "");
        oUi.setProperty("/selectedReceipt", "");
        oUi.setProperty("/recentReceiptsError", "Could not load recent receipts.");
      } finally {
        oUi.setProperty("/recentReceiptsLoading", false);
      }
    },

    _focusExtractButton: function () {
      const oButton = this.byId("extractButton");
      
    
      if (oButton && oButton.getEnabled()) {
        setTimeout(function () {
          oButton.focus();
        }, 0);
      }
    },


    onReceiptsUpdateFinished: function (oEvent) {
      const oTable = oEvent.getSource();
      const aItems = oTable.getItems();

      // console.log("oTable=", oTable);
      // console.log("aItems=", aItems);
    
      if (!aItems.length) {
        return;
      }
    
      const sSelectedId = this._ui().getProperty("/selectedReceiptId");
      // console.log("sSelectedId=", sSelectedId);
    
      const oItemToSelect = aItems.find((item) => {
        const oCtx = item.getBindingContext("ui");
        const oReceipt = oCtx && oCtx.getObject();
        return oReceipt && oReceipt.ID === sSelectedId;
      }) || aItems[0];
    
      oTable.setSelectedItem(oItemToSelect, true);
      this._focusExtractButton();
      // this._ui().setProperty("/recentReceiptsLoading", true);
    },

    _setUploadState: function (mState) {
      Object.entries(mState).forEach(([key, value]) => {
        this._ui().setProperty(`/${key}`, value);
      });
    },

    _clearDerivedResults: function () {
      this._ui().setProperty("/uploadPretty", "");
      this._ui().setProperty("/extractPretty", "");
      if (typeof this._setMatchResult === "function") {
        this._setMatchResult(null);
      } else {
        this._ui().setProperty("/match", null);
        this._ui().setProperty("/matchPretty", "");
        this._ui().setProperty("/matchHasResult", false);
        this._ui().setProperty("/matchNoResult", true);
        this._ui().setProperty("/matchStatusText", "Not matched");
        this._ui().setProperty("/matchStatusState", "None");
        this._ui().setProperty("/matchSummaryText", "");
      }
      this._ui().setProperty("/validationPretty", "");

      this._ui().setProperty("/fxResult", null);
      this._ui().setProperty("/fxPretty", "");
      this._ui().setProperty("/fxErrorMessage", "");
      this._ui().setProperty("/fxErrorTechnical", "");

      this._ui().setProperty("/posting", null);
      this._ui().setProperty("/postingPretty", "");
      this._ui().setProperty("/postingErrorMessage", "");
      this._ui().setProperty("/postingHasResult", false);
      this._ui().setProperty("/postingNoResult", true);
      this._ui().setProperty("/postingStatusText", "Not generated");
      this._ui().setProperty("/postingStatusState", "None");
      this._ui().setProperty("/postingSummaryText", "");
      this._ui().setProperty("/postingBalanceText", "");
      this._ui().setProperty("/postingBalanceState", "None");

      this._ui().setProperty("/cost", null);
      this._ui().setProperty("/costPretty", "");
      this._ui().setProperty("/costOpportunity", null);
      this._ui().setProperty("/costOpportunityPretty", "");
      this._ui().setProperty("/opportunityBusy", false);
    },

    _selectResultTab: function (sKey) {
      this._ui().setProperty("/selectedResultTab", sKey);
    
      const oTabs = this.byId("resultTabs");
      if (oTabs) {
        oTabs.setSelectedKey(sKey);
      }
    },

    _setTargetCurrency: function (value) {
      const currency = normalizeCurrency(value) || "EUR";
      this._ui().setProperty("/selectedTargetCurrency", currency);
      return currency;
    },

    _getTargetCurrency: function () {
      return this._setTargetCurrency(this._ui().getProperty("/selectedTargetCurrency"));
    },

    _validateTargetCurrency: function () {
      const currency = this._getTargetCurrency();
      if (!/^[A-Z]{3}$/.test(currency)) {
        MessageBox.warning("Please enter a 3-letter currency code such as EUR, USD, or CHF.");
        return null;
      }
      return currency;
    },

    _friendlyCurrencyError: function (currency, error, purpose) {
      const raw = getErrorText(error);
      const lower = raw.toLowerCase();
      const looksLikeMissingRate =
        lower.includes("exchange rate") ||
        lower.includes("no rate") ||
        lower.includes("not found") ||
        lower.includes("no data") ||
        lower.includes("could not find");

      if (purpose === "posting") {
        return {
          userMessage: looksLikeMissingRate
            ? `No exchange rate was found for ${currency} on the receipt date. Choose another target currency and try generating the posting proposal again.`
            : `The posting proposal could not be created in ${currency}. Choose another target currency or try again later.`,
          technicalMessage: raw
        };
      }

      return {
        userMessage: looksLikeMissingRate
          ? `No exchange rate was found for ${currency} on the receipt date. Choose another target currency and try FX conversion again.`
          : `FX conversion to ${currency} could not be completed. Choose another target currency or try again later.`,
        technicalMessage: raw
      };
    },

    onTargetCurrencyChange: function (oEvent) {
      const source = oEvent.getSource();
      const value =
        (typeof source.getValue === "function" && source.getValue()) ||
        (typeof source.getSelectedKey === "function" && source.getSelectedKey()) ||
        this._ui().getProperty("/selectedTargetCurrency");

      this._setTargetCurrency(value);

      // Once the currency changes, old FX/posting results are no longer representative
      this._ui().setProperty("/fxResult", null);
      this._ui().setProperty("/fxPretty", "");
      this._ui().setProperty("/fxErrorMessage", "");
      this._ui().setProperty("/fxErrorTechnical", "");

      this._ui().setProperty("/posting", null);
      this._ui().setProperty("/postingPretty", "");
      this._ui().setProperty("/postingErrorMessage", "");
      this._ui().setProperty("/postingHasResult", false);
      this._ui().setProperty("/postingNoResult", true);
      this._ui().setProperty("/postingStatusText", "Not generated");
      this._ui().setProperty("/postingStatusState", "None");
      this._ui().setProperty("/postingSummaryText", "");
      this._ui().setProperty("/postingBalanceText", "");
      this._ui().setProperty("/postingBalanceState", "None");
    },

    onRefreshReceipts: function () {
      this.getView().getModel().refresh();
      MessageToast.show("Receipts refreshed");
    },

   
    onReceiptSelect: function (oEvent) {
      const oListItem = oEvent.getParameter("listItem");
      const ctx = oListItem.getBindingContext("ui") || oListItem.getBindingContext();
      const receipt = ctx && ctx.getObject();
    
      if (!receipt) {
        return;
      }
    
      this._setSelectedReceiptForEditing(receipt);
      this._clearDerivedResults();
      this._selectResultTab("receipt");
    },

    onAddExtractedItem: function () {
      const oUi = this._ui();
      const receipt = oUi.getProperty("/editableReceipt") || {};
      const items = receipt.items || [];
    
      items.push({
        type: "",
        description: "",
        amount: 0,
        currency: receipt.currency || "",
        carrierId: "",
        flightNumber: "",
        bookingId: "",
        dmoConnectionId: null,
        flightDate: null
      });
    
      receipt.items = items;
    
      oUi.setProperty("/editableReceipt", receipt);
      oUi.setProperty("/selectedReceipt", this._pretty(receipt));
    },

    onRemoveExtractedItem: function (oEvent) {
      const oCtx = oEvent.getSource().getBindingContext("ui");
    
      if (!oCtx) {
        return;
      }
    
      const sPath = oCtx.getPath();
      const iIndex = Number(sPath.split("/").pop());
    
      if (Number.isNaN(iIndex)) {
        return;
      }
    
      const oUi = this._ui();
      const receipt = oUi.getProperty("/editableReceipt") || {};
      const items = receipt.items || [];
    
      items.splice(iIndex, 1);
      receipt.items = items;
    
      oUi.setProperty("/editableReceipt", receipt);
      oUi.setProperty("/selectedReceipt", this._pretty(receipt));
    },

    onResetExtractedData: function () {
      const oUi = this._ui();
      const original = oUi.getProperty("/originalExtractedReceipt");
    
      if (!original) {
        MessageBox.warning("There is no extracted data to reset.");
        return;
      }
    
      const copy = this._clone(original);
    
      oUi.setProperty("/editableReceipt", copy);
      oUi.setProperty("/selectedReceipt", this._pretty(copy));
    
      MessageToast.show("Extracted data reset.");
    },

    onAcceptExtractedData: async function () {
      const oUi = this._ui();
      const receiptId = oUi.getProperty("/selectedReceiptId");
      const corrected = oUi.getProperty("/editableReceipt");
    
      if (!receiptId) {
        MessageBox.warning("Select a receipt first.");
        return;
      }
    
      if (!corrected) {
        MessageBox.warning("There is no extracted data to save.");
        return;
      }
    
      try {
        await CopilotApi.updateExtractedReceipt(receiptId, corrected);
    
        oUi.setProperty("/originalExtractedReceipt", this._clone(corrected));
        oUi.setProperty("/selectedReceipt", this._pretty(corrected));
    
        await this._loadRecentReceipts(receiptId);
    
        MessageToast.show("Corrected extracted data saved.");
      } catch (e) {
        console.error("Could not save corrected extracted data:", e);
        MessageBox.error("Could not save corrected extracted data.");
      }
    },    


    _getSelectedReceiptId: function () {
      return this._ui().getProperty("/selectedReceiptId");
    },

    async onExtract() {
      const receiptId = this._getSelectedReceiptId();
      if (!receiptId) return MessageBox.warning("Select a receipt first.");

      try {

        this._selectResultTab("receipt");
        const receipt = await CopilotApi.extract(receiptId);
        this._ui().setProperty("/selectedReceipt", this._pretty(receipt.extractedJson));

        this._clearDerivedResults();

        // 1. Refresh right-side extracted fields
        this._setSelectedReceiptForEditing(receipt);

        // 2. Refresh the receipt in the left-side list
            const oUi = this._ui();
            const receipts = oUi.getProperty("/recentReceipts") || [];

            const index = receipts.findIndex(
              item => item.ID === receipt.ID
            );

            if (index >= 0) {
              oUi.setProperty(
                `/recentReceipts/${index}`,
                receipt
              );
            }

        MessageToast.show("Extraction finished");
      } catch (e) {
        MessageBox.error(e.message);
      }
    },

    async onValidate() {
      const receiptId = this._getSelectedReceiptId();
      if (!receiptId) return MessageBox.warning("Select a receipt first.");

      try {
        this._selectResultTab("validation");

        const response = await CopilotApi.validate(receiptId);
        const result = typeof response === "string" ? JSON.parse(response) : response;

        this._setValidationResult(result);

        // this._ui().setProperty("/validationPretty", this._pretty(result));        
        MessageToast.show("Validation finished.");

      } catch (e) {
        console.error("Validation failed:", e);
        MessageBox.error(e.message || "Validation failed.");
      }
    },

    async onMatch() {
      const receiptId = this._getSelectedReceiptId();
      if (!receiptId) return MessageBox.warning("Select a receipt first.");

      try {
        this._selectResultTab("match");
        const response = await CopilotApi.matchDMO(receiptId);
        const result = typeof response === "string" ? JSON.parse(response) : response;

        this._setMatchResult(result);

        window.oMatch = this._ui().getProperty("/match");
        window.oTravel = this._ui().getProperty("/match/travel");
        window.oMatchedBookings = this._ui().getProperty("/match/matchedBookings");

        MessageToast.show("Travel data match loaded.");
      } catch (e) {
        console.error("Match failed:", e);
        MessageBox.error(e.message || "Match failed.");
      }
    },


    async onConvertFx() {
      const receiptId = this._getSelectedReceiptId();
      if (!receiptId) return MessageBox.warning("Select a receipt first.");

      const targetCurrency = this._validateTargetCurrency();
      if (!targetCurrency) return;

      this._ui().setProperty("/fxErrorMessage", "");
      this._ui().setProperty("/fxErrorTechnical", "");
      this._ui().setProperty("/fxErrorVisible", false);

      try {
        this._selectResultTab("fx");
        const result = await CopilotApi.convertFx(receiptId, targetCurrency);
        this._ui().setProperty("/fxResult", result);
        this._ui().setProperty("/fxPretty", this._pretty(result));
        MessageToast.show(`FX conversion loaded for ${targetCurrency}`);
        this._ui().setProperty("/fxErrorVisible", false);


      } catch (e) {
        const friendly = this._friendlyCurrencyError(targetCurrency, e, "fx");
        this._ui().setProperty("/fxResult", null);
        this._ui().setProperty("/fxPretty", "");
        this._ui().setProperty("/fxErrorMessage", friendly.userMessage);
        this._ui().setProperty("/fxErrorTechnical", friendly.technicalMessage);
        this._ui().setProperty("/fxErrorVisible", true);
        MessageBox.warning(friendly.userMessage);
      }
    },


    _setPostingProposalResult: function (rawResult) {
      const oUi = this._ui();
      const result = parsePostingResult(rawResult);

      if (!result) {
        oUi.setProperty("/posting", null);
        oUi.setProperty("/postingPretty", "");
        oUi.setProperty("/postingHasResult", false);
        oUi.setProperty("/postingNoResult", true);
        oUi.setProperty("/postingStatusText", "Not generated");
        oUi.setProperty("/postingStatusState", "None");
        oUi.setProperty("/postingSummaryText", "");
        oUi.setProperty("/postingBalanceText", "");
        oUi.setProperty("/postingBalanceState", "None");
        return;
      }

      const status = buildPostingStatus(result);
      const currencyOriginal = result.currencyOriginal || null;
      const postingCurrency = result.postingCurrency || null;
      const lines = Array.isArray(result.lines) ? result.lines : [];
      const preparedLines = lines.map(function (line) {
        return preparePostingLine(line, currencyOriginal, postingCurrency);
      });

      const originalDiff = Math.abs(Number(result.totalDifferenceOriginal || 0));
      const postingDiff = Math.abs(Number(result.totalDifferencePosting || 0));
      const balanced = originalDiff <= 0.5 && postingDiff <= 0.5;

      const prepared = Object.assign({}, result, {
        lines: preparedLines,
        totalOriginalDisplay: round2Display(result.totalOriginal),
        airfareOriginalDisplay: round2Display(result.airfareOriginal),
        nonAirfareOriginalDisplay: round2Display(result.nonAirfareOriginal),
        lineSumOriginalDisplay: round2Display(result.lineSumOriginal),
        totalDifferenceOriginalDisplay: round2Display(result.totalDifferenceOriginal),
        totalPostingDisplay: round2Display(result.totalPosting),
        airfarePostingDisplay: round2Display(result.airfarePosting),
        nonAirfarePostingDisplay: round2Display(result.nonAirfarePosting),
        lineSumPostingDisplay: round2Display(result.lineSumPosting),
        totalDifferencePostingDisplay: round2Display(result.totalDifferencePosting)
      });

      const summaryText = [
        "Receipt " + (result.receiptNo || "-"),
        "Travel " + (result.travelId || "-"),
        String(preparedLines.length) + " proposed posting line" + (preparedLines.length === 1 ? "" : "s"),
        "Original " + round2Display(result.totalOriginal) + " " + (currencyOriginal || ""),
        "Posting " + round2Display(result.totalPosting) + " " + (postingCurrency || "")
      ].join(" · ");

      oUi.setProperty("/posting", prepared);
      oUi.setProperty("/postingPretty", this._pretty(result));
      oUi.setProperty("/postingHasResult", true);
      oUi.setProperty("/postingNoResult", false);
      oUi.setProperty("/postingStatusText", status.text);
      oUi.setProperty("/postingStatusState", status.state);
      oUi.setProperty("/postingSummaryText", summaryText);
      oUi.setProperty(
        "/postingBalanceText",
        balanced ? "Header total and line sum balance" : "Header total and line sum differ"
      );
      oUi.setProperty("/postingBalanceState", balanced ? "Success" : "Warning");
    },    

    _isPostingBlockedBySuspiciousMatch: function () {
      return this._ui().getProperty("/matchStatusText") === "SUSPICIOUS";
    },

    async onPostingProposal() {
      const receiptId = this._getSelectedReceiptId();
      if (!receiptId) return MessageBox.warning("Select a receipt first.");

      this._selectResultTab("posting");

      if (this._isPostingBlockedBySuspiciousMatch()) {
        const message = "Posting Proposal is blocked because Match Travel Data is SUSPICIOUS. Fix the travel/customer/booking match before creating an accounting draft.";
        this._setPostingProposalResult(null);
        this._ui().setProperty("/postingErrorMessage", message);
        MessageBox.warning(message);
        return;
      }      
      
      const targetCurrency = this._validateTargetCurrency();
      if (!targetCurrency) return;

      this._ui().setProperty("/postingErrorMessage", "");

      try {
        const result = await CopilotApi.postingProposal(receiptId, targetCurrency);        
        this._setPostingProposalResult(result);
        MessageToast.show(`Posting proposal loaded for ${targetCurrency}`);


      } catch (e) {
        const friendly = this._friendlyCurrencyError(targetCurrency, e, "posting");       
        this._setPostingProposalResult(null);
        this._ui().setProperty("/postingErrorMessage", friendly.userMessage);
        MessageBox.warning(friendly.userMessage);
      }
    },



    onDeleteReceipt: function (oEvent) {
      const oButton = oEvent.getSource();
      const oCtx = oButton.getBindingContext("ui");
      const oReceipt = oCtx && oCtx.getObject();
    
      if (!oReceipt || !oReceipt.ID) {
        MessageBox.warning("No receipt found for this row.");
        return;
      }
    
      MessageBox.confirm(
        `Are you sure you want to delete receipt "${oReceipt.fileName || oReceipt.ID}"?`,
        {
          title: "Delete Receipt",
          actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.DELETE,
          onClose: async (sAction) => {
            if (sAction !== MessageBox.Action.DELETE) {
              return;
            }
    
            try {
              this._ui().setProperty("/recentReceiptsLoading", true);
    
              
              const sSelectedId = this._ui().getProperty("/selectedReceiptId");

              const { deleted, receiptId} = await CopilotApi.deleteReceipt(oReceipt.ID);
    
              if (deleted === true && sSelectedId === receiptId) {
                this._ui().setProperty("/selectedReceiptId", "");
                this._ui().setProperty("/selectedReceipt", "");
                this._ui().setProperty("/selectedResultTab", "receipt");
                this._clearDerivedResults();
              }
    
              await this._loadRecentReceipts();
    
              MessageToast.show("Receipt deleted.");
            } catch (e) {
              console.error("Could not delete receipt:", e);
              MessageBox.error("Could not delete receipt from the database.");
            } finally {
              this._ui().setProperty("/recentReceiptsLoading", false);
            }
          }
        }
      );
    },

    formatReceiptsTitle: function (iLoaded, iTotal) {
      iLoaded = Number(iLoaded || 0);
      iTotal = Number(iTotal || 0);
    
      if (iTotal > 0) {
        return `Last ${iLoaded} of ${iTotal} Receipts`;
      }
    
      return `Last ${iLoaded} Receipts`;
    },

  },  UploadReceipt, CostAssessment, Validation, MatchDmo)
);
});
