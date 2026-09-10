#!/usr/bin/env node
"use strict";

/**
 * Convert locally exported SAP DMO/OData JSON files into CAP seed files.
 *
 * This script intentionally imports only the seven travel-reference entities
 * used by this portfolio project. It does NOT import receipts, FX cache data,
 * credentials, or service bindings.
 *
 * Usage:
 *   node scripts/import-dmo-snapshot.js --source ./local/dmo-export
 *   node scripts/import-dmo-snapshot.js --source ./local/dmo-export --target ./db/data
 *   node scripts/import-dmo-snapshot.js --source ./local/dmo-export --dry-run
 *
 * Supported input shapes:
 *   - plain JSON array
 *   - OData V4: { "value": [...] }
 *   - OData V2: { "d": { "results": [...] } }
 *
 * IMPORTANT:
 * Keep the original SAP export outside the public repository unless you have
 * confirmed that you may redistribute it.
 */

const fs = require("node:fs");
const path = require("node:path");

const ENTITIES = {
  Agencies: {
    keys: ["AgencyID"],
    fields: [
      "AgencyID", "Name", "Street", "PostalCode", "City", "CountryCode",
      "PhoneNumber", "EmailAddress", "WebAddress"
    ],
  },
  Airports: {
    keys: ["AirportID"],
    fields: [
      "AirportID", "Ident", "Name", "City", "Country", "Latitude", "Longitude",
      "ICAOCode", "AirportType", "Municipality", "ElevationFt", "IsoRegion",
      "GpsCode", "ScheduledService"
    ],
    numeric: ["Latitude", "Longitude", "ElevationFt"],
  },
  Bookings: {
    keys: ["TravelID", "BookingID"],
    fields: [
      "TravelID", "BookingID", "BookingDate", "CustomerID", "CarrierID",
      "ConnectionID", "FlightDate", "FlightPrice", "CurrencyCode"
    ],
    numeric: ["FlightPrice"],
  },
  Connections: {
    keys: ["CarrierID", "ConnectionID"],
    fields: [
      "CarrierID", "ConnectionID", "AirportFromID", "AirportToID",
      "DepartureTime", "ArrivalTime", "Distance", "DistanceUnit"
    ],
    numeric: ["Distance"],
  },
  Customers: {
    keys: ["CustomerID"],
    fields: [
      "CustomerID", "FirstName", "LastName", "Title", "Street", "PostalCode",
      "City", "CountryCode", "PhoneNumber", "EmailAddress"
    ],
  },
  Flights: {
    keys: ["CarrierID", "ConnectionID", "FlightDate"],
    fields: [
      "CarrierID", "ConnectionID", "FlightDate", "Price", "CurrencyCode",
      "PlaneTypeID", "SeatsMax", "SeatsOccupied"
    ],
    numeric: ["Price", "SeatsMax", "SeatsOccupied"],
  },
  Travels: {
    keys: ["TravelID"],
    fields: [
      "TravelID", "AgencyID", "CustomerID", "BeginDate", "EndDate",
      "BookingFee", "TotalPrice", "CurrencyCode", "Description", "Status"
    ],
    numeric: ["BookingFee", "TotalPrice"],
  },
};

const FIELD_ALIASES = {
  TravelId: "TravelID",
  BookingId: "BookingID",
  CustomerId: "CustomerID",
  AgencyId: "AgencyID",
  CarrierId: "CarrierID",
  ConnectionId: "ConnectionID",
  AirportId: "AirportID",
  AirportFromId: "AirportFromID",
  AirportToId: "AirportToID",
  PlaneTypeId: "PlaneTypeID",
  IataCode: "AirportID",
  IATACode: "AirportID",
  IcaoCode: "ICAOCode",
  GpsCode: "GpsCode",
  IsoRegion: "IsoRegion",
};

function usage() {
  console.log(`
Usage:
  node scripts/import-dmo-snapshot.js --source <directory> [options]

Options:
  --source <dir>   Directory containing exported JSON files (required)
  --target <dir>   CAP seed output directory (default: db/data)
  --dry-run        Validate and report without writing files
  --help           Show this help

Recognized file names include:
  Agencies.json
  demo.copilot.Agencies.json
  demo.copilot-Agencies.json
(and the equivalent names for the other entities)
`);
}

function parseArgs(argv) {
  const args = { target: path.join("db", "data"), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") args.source = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function unwrapRows(value, filePath) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.value)) return value.value;
  if (value?.d && Array.isArray(value.d.results)) return value.d.results;
  throw new Error(
    `Unsupported JSON shape in ${filePath}. Expected an array, ` +
    `{value:[...]}, or {d:{results:[...]}}.`
  );
}

function normalizeDate(value) {
  if (value == null || value === "") return value ?? null;
  const text = String(value).trim();
  const odataV2 = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(text);
  if (odataV2) return new Date(Number(odataV2[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return iso ? iso[1] : value;
}

function normalizeRow(row, config) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Encountered a non-object row.");
  }

  const aliased = {};
  for (const [rawKey, value] of Object.entries(row)) {
    if (rawKey === "__metadata" || rawKey.startsWith("@odata.")) continue;
    const key = FIELD_ALIASES[rawKey] || rawKey;
    aliased[key] = value;
  }

  const out = {};
  for (const field of config.fields) {
    if (!(field in aliased)) continue;
    let value = aliased[field];

    if (config.numeric?.includes(field) && value !== null && value !== "") {
      const number = Number(value);
      value = Number.isFinite(number) ? number : value;
    }

    if (/Date$/.test(field)) value = normalizeDate(value);
    out[field] = value;
  }
  return out;
}

function keyOf(row, keys) {
  return keys.map((key) => String(row[key] ?? "")).join("\u001f");
}

function validateRows(entityName, rows, config) {
  const seen = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    for (const key of config.keys) {
      if (row[key] == null || row[key] === "") {
        throw new Error(`${entityName}[${index}] is missing key field ${key}.`);
      }
    }

    const compositeKey = keyOf(row, config.keys);
    if (seen.has(compositeKey)) {
      throw new Error(
        `${entityName} contains duplicate key ${JSON.stringify(compositeKey)}.`
      );
    }
    seen.add(compositeKey);
  }
}

function normalizeFileToken(fileName) {
  return path
    .basename(fileName, path.extname(fileName))
    .toLowerCase()
    .replace(/^demo[._-]copilot[._-]/, "")
    .replace(/[^a-z0-9]/g, "");
}

function findEntityFile(sourceDir, entityName) {
  const targetToken = entityName.toLowerCase();
  const files = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));

  return files.find((entry) => normalizeFileToken(entry.name) === targetToken)?.name;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.source) {
    usage();
    throw new Error("--source is required.");
  }

  const sourceDir = path.resolve(args.source);
  const targetDir = path.resolve(args.target);

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  if (!args.dryRun) fs.mkdirSync(targetDir, { recursive: true });

  let importedEntities = 0;
  let importedRows = 0;

  for (const [entityName, config] of Object.entries(ENTITIES)) {
    const inputName = findEntityFile(sourceDir, entityName);
    if (!inputName) {
      console.warn(`[skip] ${entityName}: no matching JSON file found`);
      continue;
    }

    const inputPath = path.join(sourceDir, inputName);
    const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const rows = unwrapRows(raw, inputPath).map((row) => normalizeRow(row, config));

    validateRows(entityName, rows, config);

    const outputPath = path.join(targetDir, `demo.copilot-${entityName}.json`);
    if (!args.dryRun) {
      fs.writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    }

    console.log(
      `${args.dryRun ? "[check]" : "[write]"} ${entityName}: ` +
      `${rows.length} rows -> ${path.relative(process.cwd(), outputPath)}`
    );

    importedEntities += 1;
    importedRows += rows.length;
  }

  if (importedEntities === 0) {
    throw new Error(`No recognized DMO entity JSON files were found in ${sourceDir}.`);
  }

  console.log(
    `Done: ${importedEntities} entities, ${importedRows} rows` +
    (args.dryRun ? " validated." : " prepared for CAP.")
  );
}

try {
  main();
} catch (error) {
  console.error(`import-dmo-snapshot: ${error.message}`);
  process.exitCode = 1;
}
