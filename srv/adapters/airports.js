/**
 * Nearby-airport adapter
 * Local CAP airport coordinates -> Haversine distance -> radius-filtered alternatives.
 * No external API is used.
 */

// Geographic distance calculation from enriched airport coordinates.

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Resolve nearby airports from demo.copilot.Airports and filter by the configured radius.

async function resolveNearbyAirports(airportId, radiusKm = 80, { SELECT }) {
  const sourceAirport = await SELECT.one
    .from("demo.copilot.Airports")
    .columns(
      "AirportID",
      "Ident",
      "Name",
      "City",
      "Country",
      "Latitude",
      "Longitude",
      "ICAOCode",
      "AirportType"
    )
    .where({ AirportID: String(airportId || "").toUpperCase() });

  if (!sourceAirport) {
    throw new Error(`Airport ${airportId} not found in local Airports`);
  }

  if (sourceAirport.Latitude == null || sourceAirport.Longitude == null) {
    throw new Error(`Airport ${airportId} has no coordinates in local Airports`);
  }

  const allAirports = await SELECT.from("demo.copilot.Airports").columns(
    "AirportID",
    "Ident",
    "Name",
    "City",
    "Country",
    "Latitude",
    "Longitude",
    "ICAOCode",
    "AirportType"
  );

  const sourceLat = Number(sourceAirport.Latitude);
  const sourceLon = Number(sourceAirport.Longitude);

  const nearbyAirports = allAirports
    .filter(
      (airport) =>
        airport.AirportID !== sourceAirport.AirportID &&
        airport.Latitude != null &&
        airport.Longitude != null
    )
    .map((airport) => {
      const lat = Number(airport.Latitude);
      const lon = Number(airport.Longitude);
      const distanceKm = haversineKm(sourceLat, sourceLon, lat, lon);

      return {
        airportId: airport.AirportID,
        iata: airport.AirportID,
        ident: airport.Ident ?? null,
        icao: airport.ICAOCode ?? null,
        name: airport.Name ?? null,
        city: airport.City ?? null,
        country: airport.Country ?? null,
        lat,
        lon,
        airportType: airport.AirportType ?? null,
        distanceKm: Number(distanceKm.toFixed(2)),
      };
    })
    .filter((airport) => airport.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    sourceAirportId: sourceAirport.AirportID,
    center: {
      lat: sourceLat,
      lon: sourceLon,
    },
    radiusKm,
    nearbyAirports,
    nearestAirport: nearbyAirports[0] ?? null,
  };
}

module.exports = { resolveNearbyAirports };
