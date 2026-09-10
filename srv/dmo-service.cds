using { demo.copilot as db } from '../db/schema';

// Lightweight reference-data service used for inspection and demonstration.
// The UI annotations allow CAP's Fiori Elements preview to render useful tables.
service DmoService {

  // ---------------------------------------------------------------------------
  // Airports: enriched reference data + Fiori Elements annotations
  // ---------------------------------------------------------------------------
  @UI.HeaderInfo: {
    TypeName: 'Airport',
    TypeNamePlural: 'Airports',
    Title: { Value: AirportID },
    Description: { Value: Name }
  }

  @UI.LineItem: [
    { Value: AirportID, Label: 'Airport ID' },
    { Value: Name, Label: 'Name' },
    { Value: City, Label: 'City' },
    { Value: Country, Label: 'Country' },
    { Value: Latitude, Label: 'Latitude' },
    { Value: Longitude, Label: 'Longitude' },
    { Value: ICAOCode, Label: 'ICAO' },
    { Value: AirportType, Label: 'Type' }
  ]
  @UI.SelectionFields: [AirportID, ICAOCode, City, Country]
  entity Airports as projection on db.Airports;

  // Connections
  @UI.HeaderInfo: {
    TypeName: 'Connection',
    TypeNamePlural: 'Connections',
    Title: { Value: ConnectionID }
  }
  @UI.LineItem: [
    { Value: CarrierID, Label: 'Carrier' },
    { Value: ConnectionID, Label: 'Connection' },
    { Value: AirportFromID, Label: 'From' },
    { Value: AirportToID, Label: 'To' }
  ]
  entity Connections as projection on db.Connections;

  // Flights
  @UI.HeaderInfo: {
    TypeName: 'Flight',
    TypeNamePlural: 'Flights',
    Title: { Value: ConnectionID }
  }
  @UI.LineItem: [
    { Value: CarrierID, Label: 'Carrier' },
    { Value: ConnectionID, Label: 'Connection' },
    { Value: FlightDate, Label: 'Flight Date' },
    { Value: Price, Label: 'Price' },
    { Value: CurrencyCode, Label: 'Currency' }
  ]
  entity Flights as projection on db.Flights;

  // Travels
  @UI.HeaderInfo: {
    TypeName: 'Travel',
    TypeNamePlural: 'Travels',
    Title: { Value: TravelID }
  }
  @UI.LineItem: [
    { Value: TravelID, Label: 'Travel ID' },
    { Value: CustomerID, Label: 'Customer' },
    { Value: AgencyID, Label: 'Agency' },
    { Value: BeginDate, Label: 'Begin Date' },
    { Value: EndDate, Label: 'End Date' },
    { Value: BookingFee, Label: 'Booking Fee' },
    { Value: CurrencyCode, Label: 'Currency' }
  ]
  entity Travels as projection on db.Travels;

  // Bookings
  @UI.HeaderInfo: {
    TypeName: 'Booking',
    TypeNamePlural: 'Bookings',
    Title: { Value: BookingID }
  }
  @UI.LineItem: [
    { Value: BookingID, Label: 'Booking ID' },
    { Value: TravelID, Label: 'Travel ID' },
    { Value: BookingDate, Label: 'Booking Date' },
    { Value: CarrierID, Label: 'Carrier' },
    { Value: ConnectionID, Label: 'Connection' },
    { Value: FlightDate, Label: 'Flight Date' },
    { Value: FlightPrice, Label: 'Flight Price' },
    { Value: CurrencyCode, Label: 'Currency' }
  ]
  entity Bookings as projection on db.Bookings;

  // Customers
  @UI.HeaderInfo: {
    TypeName: 'Customer',
    TypeNamePlural: 'Customers',
    Title: { Value: CustomerID },
    Description: { Value: LastName }
  }
  @UI.LineItem: [
    { Value: CustomerID, Label: 'Customer ID' },
    { Value: FirstName, Label: 'First Name' },
    { Value: LastName, Label: 'Last Name' }
  ]
  entity Customers as projection on db.Customers;

  // Agencies
  @UI.HeaderInfo: {
    TypeName: 'Agency',
    TypeNamePlural: 'Agencies',
    Title: { Value: AgencyID },
    Description: { Value: Name }
  }
  @UI.LineItem: [
    { Value: AgencyID, Label: 'Agency ID' },
    { Value: Name, Label: 'Name' },
    { Value: City, Label: 'City' },
    { Value: CountryCode, Label: 'Country' }
  ]
  entity Agencies as projection on db.Agencies;
}