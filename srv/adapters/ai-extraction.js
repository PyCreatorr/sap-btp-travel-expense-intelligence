/**
 * AI EXTRACTION ADAPTER
 *
 * Purpose:
 *   Convert already-extracted receipt text into one canonical JSON structure.
 *
 * Providers:
 *   OpenAI or Gemini, selected through LLM_PROVIDER.
 *
 * Used by:
 *   The extraction handler via extractReceiptFields(pdfText).
 *
 * Architectural boundary:
 *   Provider-specific SDK calls and prompt engineering stay here.
 *   The business handler only consumes the adapter's canonical JSON result.
 *
 * Flow:
 *   receipt text -> canonical extraction prompt -> selected LLM
 *                -> clean JSON response -> CAP extraction workflow
 */

const dotenv = require("dotenv");
dotenv.config();

const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

// -----------------------------------------------------------------------------
// 1. Provider selection
// -----------------------------------------------------------------------------

// Choose provider via environment configuration
const PROVIDER = process.env.LLM_PROVIDER || "GEMINI"; // "OPENAI" | "GEMINI"

console.log("Provider = ", PROVIDER);

// -----------------------------------------------------------------------------
// 2. Canonical extraction contract / prompt
// -----------------------------------------------------------------------------
// #region Canonical extraction prompt
function buildPrompt(pdfText) {
  return `
  You extract structured data from travel receipt text.

  Return ONLY valid JSON (no markdown, no backticks, no extra text).
  If a value is not explicitly present in the text, use null (for strings/dates) and 0 (for numbers).

  Output JSON schema:
  {
    "documentType": "AIR|HOTEL|RAIL|TAXI|OTHER",
    "receiptNo": string | null,
    "receiptDate": string | null,        // YYYY-MM-DD
    "travelId": string | null,
    "supplier": string | null,
    "currency": string | null,           // ISO 4217, e.g. USD, EUR
    "customers": [
      {
        "customerId": string | null,
        "name": string | null,
        "role": "Employee/Traveler|Passenger|Customer|Unknown"
      }
    ],
    "customerCount": number,
    "totalAmount": number,               // numeric total in 'currency' (0 if missing)
    "flightLegs": [
      {
        "leg": number,
        "carrierId": string | null,
        "flightNumber": string | null,
        "route": string | null,
        "fromAirport": string | null,
        "toAirport": string | null,
        "flightDate": string | null,
        "departureTime": string | null,
        "arrivalTime": string | null,
        "aircraft": string | null,
        "farePerPassenger": number,
        "currency": string | null
      }
    ],
    "items": [
      {
        "type": "Airfare|Lodging|Transport|Meal|Fee|Taxes|Other",
        "description": string | null,
        "amount": number,                // numeric
        "currency": string | null,       // ISO 4217 (null if unknown)
        "carrierId": string | null,      // e.g. UA, AA (AIR only)
        "flightNumber": string | null,   // digits only, keep leading zeros, e.g. "0322" (AIR only)
        "bookingId": string | null,      // booking id as shown, keep leading zeros, e.g. "0001" (AIR only)
        "dmoConnectionId": string | null,// ONLY if text explicitly says "Connection ID" / "Connection:" (AIR only)
        "flightDate": string | null      // YYYY-MM-DD (AIR only)
      }
    ]
  }

  Rules:
  - JSON must parse strictly.
  - Dates must be YYYY-MM-DD if present; otherwise null.
  - Amounts must be numbers (no currency symbols).
  - Use the decimal separator exactly as a dot for monetary values, e.g. 210.44.
  - Read monetary amounts only from the value that is directly attached to a currency code or directly placed in the Amount column.
  - Treat a number as a monetary amount only if it is in an Amount column or is written as a money value, normally with decimals and/or a currency code, such as "210.44 USD", "80.00 USD", "USD 210.44", or "$210.44".
  - A standalone identifier-like number without decimals and without a nearby currency code is NOT a price or amount. For example, in "Flight BA 3224 (Booking 0001)", 3224 is the flightNumber and 0001 is the bookingId; neither is an amount.
  - Never infer a price from a flight number, booking ID, customer ID, leg number, connection ID, date, time, distance, or aircraft model.
  - Never concatenate labels or identifiers with monetary amounts. Examples:
    - "Leg 1 210.44 USD" means amount=210.44, NOT 1210.44.
    - "Leg 2 233.60 USD" means amount=233.60, NOT 2233.60.
    - "Booking 0001 210.44 USD" means bookingId="0001" and amount=210.44, NOT 1210.44 or 10001210.44.
    - "Flight BA 3224 (Booking 0001)" means flightNumber="3224" and bookingId="0001"; amount must stay 0/null unless a separate money value is shown.
  - Numbers that are leg numbers, booking IDs, customer IDs, flight numbers, dates, distances, aircraft names, or times must never be merged into an amount.
  - If a displayed amount has two decimal places like 233.60, the numeric value is 233.60. Note: JSON numbers may be serialized as 233.6 after parsing; this is numerically correct. UI formatting should display two decimals for currency.
  - 'currency' is the receipt currency. Each item currency should usually match receipt currency.
  - Customers / travelers / passengers:
    - Extract all people/customer/traveler/passenger references into customers.
    - customerId is optional. Use it only if the receipt explicitly shows a Customer ID or passenger/customer number.
    - Keep leading zeros in customerId, e.g. "000035".
    - name is optional. Use the name exactly as shown in the receipt.
    - If only a first name is shown, still store it in name.
    - If only a customerId is shown, set name to null.
    - If only a name is shown, set customerId to null.
    - If both are shown, set both.
    - If the text contains "Employee / Traveler", create a customers entry with role "Employee/Traveler".
    - If the text contains "Passengers", create one customers entry per passenger line with role "Passenger".
    - customerCount must be the number of extracted customer entries.
    - Do not invent customer IDs or names.
  - Determine documentType:
    - AIR if it mentions Flight, Carrier, IATA airports (e.g., EWR), boarding/itinerary legs.
    - HOTEL if it mentions hotel, check-in/out, nights, room rate.
    - RAIL if it mentions train, rail, ticket, station.
    - TAXI if it mentions taxi/ride, pickup/dropoff.
    - OTHER otherwise.
  - Flight legs:
    - Use flightLegs for itinerary / route / flight details.
    - Do not use flightLegs as charge lines.
    - If the itinerary has one row per leg, create one flightLeg per row.
    - If flight number is shown like "UA 1537", set carrierId="UA" and flightNumber="1537".
    - If route is shown like "EWR → MIA", set fromAirport="EWR", toAirport="MIA", and route="EWR → MIA".
    - If fare is shown as "fare / pax", store it in farePerPassenger.
  - Items:
    - Items are financial charge lines only.
    - Items should add up approximately to totalAmount.
    - Create one item per charge line if possible, such as flight fares, taxes, booking fee, hotel rate, taxi fare.
    - Itinerary rows belong into flightLegs, not into items.
    - In the Charges table, the item amount is the value in the Amount column or the value immediately before/after the currency code.
    - Do not use itinerary/header numbers as item amounts. A line like "Flight BA 3224 (Booking 0001)" is itinerary metadata only: flightNumber="3224", bookingId="0001", amount=0/null.
    - If a number has no decimal part and no adjacent currency code (for example 3224, 0001, 622, 737-800), treat it as an identifier/detail, not as money.
    - Keep descriptive labels like "Leg 1", "Leg 2", "Booking 0001", "Flight BA 3224" only in description/booking/flight fields. Do not merge their digits into amount.
    - Correct charge-line examples:
      - "Flight fare (booked) - Leg 1 210.44 USD" -> description="Flight fare (booked) - Leg 1", amount=210.44, currency="USD".
      - "Flight fare (booked) - Leg 2 233.60 USD" -> description="Flight fare (booked) - Leg 2", amount=233.60, currency="USD".
      - "Agency booking fee 80.00 USD" -> amount=80.00.
      - "Taxes & fees 0.00 USD" -> amount=0.00.
    - Incorrect examples that must never happen:
      - Do not read "Leg 1 210.44 USD" as amount=1210.44.
      - Do not read "Leg 2 233.60 USD" as amount=2233.60.
      - Do not read booking ID "0001" or flight number "3224" as part of the amount.
      - Do not read "Flight BA 3224 (Booking 0001)" as amount=3224 or amount=0001. It has no monetary amount.
      - Do not read "Aircraft 737-800" or "Distance 622 KM" as an item amount.
    - If item amounts do not add up to totalAmount, re-read the Charges table and correct item amounts before returning JSON. Prefer the charge-table amounts over itinerary labels.
    - If a flight leg has its own final charged amount, it may appear as an Airfare item with carrierId, flightNumber, bookingId, and flightDate if those values are explicitly associated with that charge line or can be clearly connected by "Leg 1" / "Leg 2" labels from the itinerary.
    - If the receipt has a summarized charge like "Flight fares total for 3 passengers", use that summarized charge as the Airfare item.
    - Do not use farePerPassenger as an item amount unless it is clearly the final charged invoice amount.
    - For AIR charge items, only set carrierId, flightNumber, bookingId, dmoConnectionId, and flightDate if those values are explicitly shown on that charge line itself or can be clearly linked by the leg label.
    - Do NOT put bookingId into flightNumber, and do NOT invent dmoConnectionId.
  - Validation:
    - Sum of item amounts should approximately equal totalAmount when charges are listed.
    - If the sum differs from totalAmount by a large amount, the most likely error is that a leg number, booking ID, flight number, date, or other label was merged into an amount. Fix that before returning JSON.
    - If charges list exists, prefer that over other totals.
  - AIR fare logic:
    - If itinerary lines show "fare / pax", that amount is per passenger, not the full receipt charge.
    - If the Charges section has "Flight fares total for X passengers", use that as the total airfare charge.
    - Do not create one receipt charge item of 438.00 if the Charges section gives the real total airfare.
    - You may still keep leg-level details in the description.
  Receipt text:
  ${pdfText}
`.trim();
}

// #endregion

// -----------------------------------------------------------------------------
// 3. Provider client initialization
// -----------------------------------------------------------------------------

// Init clients
let openaiClient = null;
let geminiClient = null;

let model;
let temperature;

if (PROVIDER === "OPENAI") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  model = process.env.OPENAI_MODEL || "gpt-5.2";
  temperature = parseFloat(process.env.OPENAI_TEMPERATURE || "0.2");

  openaiClient = new OpenAI({ apiKey });
} else if (PROVIDER === "GEMINI") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  temperature = parseFloat(process.env.GEMINI_TEMPERATURE || "0.2");

  geminiClient = new GoogleGenAI({ apiKey });
  console.log("We've used GEMINI");
} else {
  throw new Error(`Unknown LLM_PROVIDER: ${PROVIDER}`);
}

// -----------------------------------------------------------------------------
// 4. Normalize provider output to strict JSON text
// -----------------------------------------------------------------------------

// Small helper to harden JSON parsing
function cleanJson(text) {
  return (text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

// -----------------------------------------------------------------------------
// 5. Single adapter entry point used by the CAP extraction handler
// -----------------------------------------------------------------------------

async function extractReceiptFields(pdfText) {
  const prompt = buildPrompt(pdfText);

  if (PROVIDER === "OPENAI") {
    const response = await openaiClient.responses.create({
      model,
      input: [{ role: "user", content: prompt }]
    });

    const resp = cleanJson(response.output_text);
    console.log("Raw OPENAI response:", resp);

    return resp;
  }

  // GEMINI
  const resp = await geminiClient.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json"
    }
  });

  const response = cleanJson(resp.text);

  console.log("Raw GEMINI response:", response);

  return response;
}

module.exports = { extractReceiptFields };