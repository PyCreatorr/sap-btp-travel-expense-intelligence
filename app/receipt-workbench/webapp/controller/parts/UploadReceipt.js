/**
 * UploadReceipt — SAPUI5 receipt ingestion flow
 *
 * Architecture:
 *   FileUploader -> FileReader -> Base64 JSON payload
 *   -> CopilotApi -> CAP OData V4 uploadReceipt action
 *
 * Recording focus:
 *   1) File -> Base64 conversion
 *   2) frontend/backend boundary via CopilotApi.uploadReceipt()
 *   3) optional hand-off to extraction
 */

sap.ui.define([
  "sap/base/Log",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "demo/copilot/receiptworkbench/controller/Workbench.controller",
  "demo/copilot/receiptworkbench/service/CopilotApi",
], function (
  Log,
  Fragment,
  MessageBox,
  MessageToast,
  _pretty,
  CopilotApi
) {
  "use strict";

  return {

    // -------------------------------------------------------------------------
    // 1. Open and initialize the upload dialog
    // -------------------------------------------------------------------------
    async onOpenUpload() {
      Log.info("Opening upload dialog", null, "receipt-workbench");

      this._selectResultTab("upload");

      if (!this._pUploadDialog) {
        this._pUploadDialog = Fragment.load({
          id: this.getView().getId(),
          name: "demo.copilot.receiptworkbench.fragment.UploadDialog",
          controller: this,
        }).then((oDialog) => {
          this.getView().addDependent(oDialog);
          return oDialog;
        });
      }

      this._pendingUpload = null;

      this._setUploadState({
        uploadFileName: "",
        uploadBusy: false,
        uploadAutoExtract: true,
      });

      const oDialog = await this._pUploadDialog;
      const oUploader = Fragment.byId(
        this.getView().getId(),
        "receiptFileUploader"
      );

      if (oUploader) {
        oUploader.clear();
      }

      oDialog.open();
    },

    async onCloseUploadDialog() {
      if (this._pUploadDialog) {
        const oDialog = await this._pUploadDialog;
        oDialog.close();
      }
    },

    // -------------------------------------------------------------------------
    // 2. Receive and validate the browser File object
    //    No backend request is made yet.
    // -------------------------------------------------------------------------
    onUploadFileChange: function (oEvent) {
      const aFiles = oEvent.getParameter("files") || [];
      const oFile = aFiles[0];

      if (!oFile) {
        this._pendingUpload = null;
        this._setUploadState({ uploadFileName: "" });
        return;
      }

      if (!/\.pdf$/i.test(oFile.name) && oFile.type !== "application/pdf") {
        this._pendingUpload = null;
        this._setUploadState({ uploadFileName: "" });
        MessageBox.warning("Please choose a PDF file.");
        return;
      }

      this._pendingUpload = oFile;
      this._setUploadState({ uploadFileName: oFile.name });
    },

    // -------------------------------------------------------------------------
    // 3. Browser-side transport preparation
    //    FileReader converts the selected PDF to a Base64 Data URL.
    //    Only the Base64 payload is returned for JSON/OData transport.
    // -------------------------------------------------------------------------
    _readFileAsBase64: function (oFile) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const result = String(reader.result || "");

          const base64 = result.includes("base64,")
            ? result.split("base64,").pop()
            : result;

          resolve(base64);
        };

        reader.onerror = reject;
        reader.readAsDataURL(oFile);
      });
    },

    // -------------------------------------------------------------------------
    // 4. Frontend -> CAP boundary
    //
    //    File
    //      -> Base64
    //      -> CopilotApi.uploadReceipt(...)
    //      -> CAP OData V4 action
    //      -> returned Receipt
    // -------------------------------------------------------------------------
    async onUploadReceiptConfirm() {
      if (!this._pendingUpload) {
        MessageBox.warning("Choose a PDF file first.");
        return;
      }

      try {
        this._setUploadState({ uploadBusy: true });

        // Local browser operation: File -> Base64.
        const base64 = await this._readFileAsBase64(this._pendingUpload);

        // CopilotApi serializes the payload as JSON and invokes uploadReceipt.
        const uploaded = await CopilotApi.uploadReceipt({
          fileName: this._pendingUpload.name,
          mimeType: this._pendingUpload.type || "application/pdf",
          base64,
        });

        this._ui().setProperty(
          "/selectedReceiptId",
          this._pretty(uploaded.ID)
        );
        this._ui().setProperty(
          "/selectedReceipt",
          this._pretty(uploaded)
        );

        this._clearDerivedResults();
        this.getView().getModel().refresh();

        // ---------------------------------------------------------------------
        // 5. Optional hand-off to AI extraction
        //    When enabled, the next CAP action starts immediately after upload.
        // ---------------------------------------------------------------------
        if (this._ui().getProperty("/uploadAutoExtract")) {
          const extracted = await CopilotApi.extract(uploaded.ID);
          this._ui().setProperty(
            "/selectedReceipt",
            this._pretty(extracted)
          );
        }

        this._selectResultTab("receipt");
        await this.onCloseUploadDialog();
        MessageToast.show("Receipt uploaded successfully");
      } catch (e) {
        MessageBox.error(e.message || "Upload failed");
      } finally {
        this._setUploadState({ uploadBusy: false });
        await this._loadRecentReceipts();
      }
    },
  };
});
