const cds = require("@sap/cds");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const crypto = require("crypto");

const upload = multer({ storage: multer.memoryStorage() });
const { INSERT, SELECT } = cds.ql;

cds.on("bootstrap", (app) => {
  app.post("/upload-pdf", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const contentHash = crypto
        .createHash("sha256")
        .update(file.buffer)
        .digest("hex");

      const existing = await SELECT.one
        .from("demo.copilot.Receipt")
        .where({ contentHash });

      if (existing) {
        return res.json({
          ...existing,
          duplicate: true,
          duplicateReason: "Same file content already uploaded",
        });
      }

      const ID = cds.utils.uuid();

      let extractedText = null;
      let status = "NEW";
      let parseError = null;

      try {
        const parsed = await pdfParse(file.buffer);
        extractedText = parsed?.text || null;
      } catch (e) {
        console.error("upload-pdf parse failed", e);
        status = "PARSE_ERROR";
        parseError = e?.message || "PDF parsing failed";
      }

      await INSERT.into("demo.copilot.Receipt").entries({
        ID,
        fileName: file.originalname,
        mimeType: file.mimetype,
        contentHash,
        extractedText,
        status
      });

      const saved = await SELECT.one
        .from("demo.copilot.Receipt")
        .where({ ID });

      return res.json({
        ...saved,
        duplicate: false,
        parseError
      });
    } catch (e) {
      console.error("upload-pdf failed", e);
      return res.status(500).json({ error: e.message || "Upload failed" });
    }
  });
});

module.exports = cds.server;