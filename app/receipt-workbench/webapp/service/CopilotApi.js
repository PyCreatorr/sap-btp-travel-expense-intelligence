sap.ui.define([], function () {
  "use strict";

  const BASE = "/odata/v4/copilot";

  let csrfToken = null;

  function isLocalhost() {
    return (
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1"
    );
  }

  async function readResponseBody(response) {
    const text = await response.text();

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  async function getCsrfToken() {
    if (csrfToken) {
      return csrfToken;
    }

    try {
      const response = await fetch(`${BASE}/`, {
        method: "GET",
        headers: {
          "x-csrf-token": "Fetch",
          "Accept": "application/json"
        },
        credentials: "include"
      });

      csrfToken = response.headers.get("x-csrf-token");

      if (!csrfToken) {
        console.warn("No CSRF token returned. Continuing without token.");
        return null;
      }

      return csrfToken;
    } catch (e) {
      if (isLocalhost()) {
        console.warn("Could not fetch CSRF token locally. Continuing without token.", e);
        return null;
      }

      throw e;
    }
  }

  async function postAction(name, payload, retryAfterCsrfFailure) {
    const token = await getCsrfToken();

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };

    if (token) {
      headers["x-csrf-token"] = token;
    }

    const response = await fetch(`${BASE}/${name}`, {
      method: "POST",
      headers: headers,
      credentials: "include",
      body: JSON.stringify(payload || {})
    });

    if (
      response.status === 403 &&
      !retryAfterCsrfFailure
    ) {
      const errorText = await response.text();

      if (
        errorText &&
        errorText.toLowerCase().includes("x-csrf-token")
      ) {
        csrfToken = null;
        await getCsrfToken();
        return postAction(name, payload, true);
      }

      throw new Error(errorText || "Forbidden");
    }

    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch (e) {}
      throw new Error(text || `Request failed: ${response.status}`);
    }

    return readResponseBody(response);
  }

  function tryParseJsonString(value) {
    if (typeof value !== "string") {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch (e) {
      return value;
    }
  }

  return {
    async listReceipts(top = 5) {
      const response = await fetch(
        `${BASE}/Receipts?$orderby=createdAt desc&$top=${encodeURIComponent(top)}`,
        {
          credentials: "include",
          headers: {
            "Accept": "application/json"
          }
        }
      );

      if (!response.ok) {
        let text = "";
        try {
          text = await response.text();
        } catch (e) {}
        throw new Error(text || `Request failed: ${response.status}`);
      }

      const result = await response.json();
      return Array.isArray(result.value) ? result.value : [];
    },

    async uploadReceipt({ fileName, mimeType, base64 }) {
      return postAction("uploadReceipt", {
        fileName,
        mimeType,
        base64
      });
    },

    async extract(receiptId) {
      return postAction("extract", {
        receiptId
      });
    },

    async matchDMO(receiptId) {
      const result = await postAction("matchDMO", {
        receiptId
      });

      return tryParseJsonString(result && (result.value || result));
    },

    async validate(receiptId) {
      const result = await postAction("validate", {
        receiptId
      });

      return tryParseJsonString(result && (result.value || result));
    },

    async convertFx(receiptId, toCurrency) {
      return postAction("convertFx", {
        receiptId,
        toCurrency
      });
    },

    async postingProposal(receiptId, postingCurrency) {
      return postAction("postingProposal", {
        receiptId,
        postingCurrency
      });
    },

    async assessCostEfficiency(receiptId, filters) {
      return postAction(
        "assessCostEfficiency",
        Object.assign(
          {
            receiptId
          },
          filters || {}
        )
      );
    },

    async checkCheaperOpportunities(receiptId, filters) {
      return postAction(
        "checkCheaperOpportunities",
        Object.assign(
          {
            receiptId
          },
          filters || {}
        )
      );
    },

    async deleteReceipt(receiptId) {
      return postAction("deleteReceipt", {
        receiptId
      });
    },

    async updateExtractedReceipt(receiptId, extractedJson) {
      return postAction("updateExtractedReceipt", {
        receiptId,
        extractedJson: JSON.stringify(extractedJson)
      });
    },

    async countReceipts() {
      const response = await fetch(`${BASE}/Receipts/$count`, {
        credentials: "include"
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Count failed: ${response.status}`);
      }

      const countText = await response.text();
      return Number(countText);
    }
  };
});