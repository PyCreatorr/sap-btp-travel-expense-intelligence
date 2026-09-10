/**
 * FOREIGN-EXCHANGE ADAPTER
 *
 * Purpose:
 *   Retrieve a historical or latest FX rate for one currency pair.
 *
 * Provider:
 *   Frankfurter API (ECB reference-rate data).
 *
 * Used by:
 *   The CAP FX handler. Database caching remains outside this adapter.
 *
 * Flow:
 *   receipt date + base currency + target currency
 *   -> external FX API
 *   -> normalized { rate, source, effectiveDate }
 */

// -----------------------------------------------------------------------------
// External provider call
// -----------------------------------------------------------------------------

async function getFxRate(rateDate, base, symbol) {
  const datePart = rateDate ? String(rateDate) : "latest";

  console.log("rateDate=", rateDate);

  const url = `https://api.frankfurter.app/${datePart}?base=${encodeURIComponent(
    base
  )}&symbols=${encodeURIComponent(symbol)}`;

  console.log("url=", url);
  
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`FX API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const rate = data?.rates?.[symbol];

  if (rate == null) {
    throw new Error(
      `No rate for ${base}->${symbol} on ${data?.date || datePart}`
    );
  }

  return {
    rate: Number(rate),
    source: "Frankfurter/ECB",
    effectiveDate: data.date,
  };
}

module.exports = { getFxRate };
