sap.ui.define([
  "demo/copilot/receiptworkbench/controller/Workbench.controller"
], function (_pretty) {
    "use strict";
    return{
        _setValidationResult: function (result) {
            const oUi = this._ui();

            const missing = result.missing || [];
            const warnings = result.warnings || [];

            oUi.setProperty("/validationMissing", missing);
            oUi.setProperty("/validationWarnings", warnings);
            oUi.setProperty("/validationHasMissingFields", missing.length > 0);
            oUi.setProperty("/validationHasWarnings", warnings.length > 0);

            if (!result) {
                    oUi.setProperty("/validation", null);
                    oUi.setProperty("/validationItems", []);
                    oUi.setProperty("/validationWarnings", []);
                    oUi.setProperty("/validationMissing", []);
                    oUi.setProperty("/validationHasResult", false);
                    oUi.setProperty("/validationNoResult", true);
                    oUi.setProperty("/validationStatusText", "Not validated");
                    oUi.setProperty("/validationStatusState", "None");
                    oUi.setProperty("/validationSummaryText", "");
                    oUi.setProperty("/validationPretty", "");
                    oUi.setProperty("/validationHasMissingFields", false);
                    oUi.setProperty("/validationHasWarnings", false);
                return;
            }

            const severity = result.severity || "UNKNOWN";

            let state = "None";
            if (severity === "OK") {
                state = "Success";
            } else if (severity === "WARN") {
                state = "Warning";
            } else if (severity === "FAIL") {
                state = "Error";
            }

            const summary = result.summary || {};
            const checks = result.checks || {};
            // const items = checks.items || [];
            const items = (checks.items || []).map((item) => {
                return Object.assign({}, item, {
                    statusText: item.ok ? "OK" : "Check",
                    statusState: item.ok ? "Success" : "Warning",
                    warningText:
                    Array.isArray(item.warnings) && item.warnings.length
                        ? item.warnings.join(" ")
                        : ""
                });
                });

            window.oValidationChecks = checks;
            window.oValidationItems = items;

            const summaryText =
                "Receipt " +
                (summary.receiptNo || "-") +
                " · Travel " +
                (summary.travelId || "-") +
                " · " +
                (summary.totalAmount != null ? summary.totalAmount : "-") +
                " " +
                (summary.currency || "");

            oUi.setProperty("/validation", result);
            oUi.setProperty("/validationItems", items);
            oUi.setProperty("/validationWarnings", result.warnings || []);
            oUi.setProperty("/validationMissing", result.missing || []);
            oUi.setProperty("/validationHasResult", true);
            oUi.setProperty("/validationNoResult", false);
            oUi.setProperty("/validationStatusText", severity);
            oUi.setProperty("/validationStatusState", state);
            oUi.setProperty("/validationSummaryText", summaryText);
            oUi.setProperty("/validationPretty", this._pretty(result));
        },

        formatWarningList: function (warnings) {
            if (!Array.isArray(warnings) || warnings.length === 0) {
                return "";
            }

            return warnings.join(" ");
        },

    };
});