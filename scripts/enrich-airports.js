#!/usr/bin/env node
"use strict";

/**
 * Enrich the CAP Airports seed with geographic metadata from OurAirports.
 *
 * By default the script also adds additional OurAirports records that have a
 * valid three-character IATA code. This reproduces the broad airport reference
 * layer used by the portfolio application for nearby-airport benchmarking.
 *
 * No network request is made. Download airports.csv yourself from OurAirports
 * and pass the local file with --ourairports.
 *
 * Usage:
 *   node scripts/enrich-airports.js --ourairports ./local/airports.csv
 *   node scripts/enrich-airports.js --ourairports ./local/airports.csv --only-existing
 *   node scripts/enrich-airports.js --ourairports ./local/airports.csv --dry-run
 *
 * IMPORTANT:
 * Document the OurAirports source/license in the public repository. Keep any
 * SAP-derived source snapshot private unless redistribution rights are clear.
 */

const fs = require("node:fs");
const path = require("node:path");

function usage() {
  console.log(`
Usage:
  node scripts/enrich-airports.js --ourairports <airports.csv> [options]

Options:
  --ourairports <file>  Local OurAirports airports.csv (required)
  --input <file>        Base CAP Airports JSON
                        (default: db/data/demo.copilot-Airports.json)
  --output <file>       Output JSON (default: same as --input)
  --only-existing       Enrich only airports already present in the base file
  --dry-run             Validate and report without writing
  --help                Show this help

Default behavior:
  Enrich existing airports and add additional OurAirports rows with a valid
  3-character IATA code, producing a broader local airport reference layer.
`);
}

function parseArgs(argv) {
  const defaultAirports = path.join("db", "data", "demo.copilot-Airports.json");
  const args = {
    input: defaultAirports,
    output: defaultAirports,
    onlyExisting: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ourairports") args.ourairports = argv[++i];
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--only-existing") args.onlyExisting = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

// RFC-4180-style parser sufficient for the OurAirports CSV, including quoted
// commas, escaped quotes, CRLF, and embedded newlines inside quoted values.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error("CSV ended inside a quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((value) => value.trim());
  return rows
    .slice(1)
    .filter((values) => values.some((value) => value !== ""))
    .map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
    );
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asInteger(value) {
  const number = asNumber(value);
  return number == null ? null : Math.trunc(number);
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeIata(value) {
  const iata = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{3}$/.test(iata) ? iata : null;
}

function normalizeCode(value, maxLength) {
  const code = clean(value);
  if (!code) return null;
  return code.toUpperCase().slice(0, maxLength);
}

function candidateScore(row) {
  const typeScore = {
    large_airport: 40,
    medium_airport: 30,
    small_airport: 20,
    seaplane_base: 10,
    heliport: 5,
    closed: -100,
  }[row.type] ?? 0;

  const scheduled = row.scheduled_service === "yes" ? 100 : 0;
  const gps = clean(row.gps_code) ? 5 : 0;
  const coords =
    asNumber(row.latitude_deg) != null && asNumber(row.longitude_deg) != null ? 5 : 0;

  return scheduled + typeScore + gps + coords;
}

function bestRowsByIata(rows) {
  const best = new Map();
  let duplicateIataRows = 0;

  for (const row of rows) {
    const iata = normalizeIata(row.iata_code);
    if (!iata) continue;

    const current = best.get(iata);
    if (!current || candidateScore(row) > candidateScore(current)) {
      if (current) duplicateIataRows += 1;
      best.set(iata, row);
    } else {
      duplicateIataRows += 1;
    }
  }

  return { best, duplicateIataRows };
}

function deriveIcao(row) {
  const gps = normalizeCode(row.gps_code, 10);
  if (gps && /^[A-Z0-9]{4}$/.test(gps)) return gps;

  const ident = normalizeCode(row.ident, 10);
  if (ident && /^[A-Z0-9]{4}$/.test(ident)) return ident;

  return null;
}

function enrich(base, source) {
  const airportId = normalizeIata(base.AirportID ?? source?.iata_code);
  if (!airportId) {
    throw new Error(`Invalid or missing AirportID: ${JSON.stringify(base.AirportID)}`);
  }

  return {
    AirportID: airportId,
    Ident: normalizeCode(source?.ident ?? base.Ident, 10),
    Name: clean(base.Name) ?? clean(source?.name),
    City: clean(base.City) ?? clean(source?.municipality),
    Country:
      normalizeCode(base.Country, 2) ??
      normalizeCode(source?.iso_country, 2),
    Latitude: asNumber(source?.latitude_deg ?? base.Latitude),
    Longitude: asNumber(source?.longitude_deg ?? base.Longitude),
    ICAOCode: deriveIcao(source ?? {}) ?? normalizeCode(base.ICAOCode, 4),
    AirportType: clean(source?.type) ?? clean(base.AirportType),
    Municipality: clean(source?.municipality) ?? clean(base.Municipality),
    ElevationFt: asInteger(source?.elevation_ft ?? base.ElevationFt),
    IsoRegion: normalizeCode(source?.iso_region ?? base.IsoRegion, 10),
    GpsCode: normalizeCode(source?.gps_code ?? base.GpsCode, 10),
    ScheduledService:
      clean(source?.scheduled_service ?? base.ScheduledService)?.toLowerCase() ?? null,
  };
}

function readJsonArray(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${filePath}.`);
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.ourairports) {
    usage();
    throw new Error("--ourairports is required.");
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const csvPath = path.resolve(args.ourairports);

  if (!fs.existsSync(inputPath)) throw new Error(`Base airport file not found: ${inputPath}`);
  if (!fs.existsSync(csvPath)) throw new Error(`OurAirports CSV not found: ${csvPath}`);

  const baseRows = readJsonArray(inputPath);
  const ourAirportsRows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const { best: sourceByIata, duplicateIataRows } = bestRowsByIata(ourAirportsRows);

  const merged = new Map();
  let matchedBase = 0;
  let unmatchedBase = 0;

  for (const base of baseRows) {
    const airportId = normalizeIata(base.AirportID);
    if (!airportId) {
      console.warn(`[skip] base row with invalid AirportID: ${JSON.stringify(base.AirportID)}`);
      continue;
    }

    const source = sourceByIata.get(airportId);
    if (source) matchedBase += 1;
    else unmatchedBase += 1;

    merged.set(airportId, enrich(base, source));
  }

  let addedOpenAirports = 0;
  if (!args.onlyExisting) {
    for (const [airportId, source] of sourceByIata.entries()) {
      if (merged.has(airportId)) continue;
      merged.set(airportId, enrich({ AirportID: airportId }, source));
      addedOpenAirports += 1;
    }
  }

  const outputRows = [...merged.values()].sort((a, b) =>
    a.AirportID.localeCompare(b.AirportID)
  );

  const withCoordinates = outputRows.filter(
    (row) => row.Latitude != null && row.Longitude != null
  ).length;

  console.log(`Base airports: ${baseRows.length}`);
  console.log(`Matched to OurAirports: ${matchedBase}`);
  console.log(`Base airports without OurAirports match: ${unmatchedBase}`);
  console.log(`Duplicate IATA candidates resolved: ${duplicateIataRows}`);
  console.log(`Additional open-data airports added: ${addedOpenAirports}`);
  console.log(`Output airports: ${outputRows.length}`);
  console.log(`Output airports with coordinates: ${withCoordinates}`);

  if (args.dryRun) {
    console.log("[dry-run] No file written.");
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(outputRows, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`enrich-airports: ${error.message}`);
  process.exitCode = 1;
}
