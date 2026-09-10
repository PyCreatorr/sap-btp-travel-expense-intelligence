namespace demo.copilot;

using { cuid, managed } from '@sap/cds/common';

entity Receipt : cuid, managed {
  fileName        : String(255);
  mimeType        : String(100);
  contentHash     : String(64);
  extractedJson   : LargeString;    // structured AI extraction result
  extractedText   : LargeString;    // parsed PDF text
  travelId        : String(20);
  currency        : String(3);
  totalAmount     : Decimal(15,2);
  receiptDate     : Date;
  status          : String(30);     // NEW | EXTRACTED | VALIDATED | MATCHED
}

entity FxRateCache : cuid, managed {
  rateDate  : Date;
  base      : String(3);
  symbol    : String(3);
  rate      : Decimal(15,8);
  source    : String(50);
}

entity Airports {
  key AirportID        : String(3);   // IATA code
      Ident            : String(10);  // ourairports ident
      Name             : String(255);
      City             : String(255);
      Country          : String(2);   // iso_country from airports.csv
      Latitude         : Decimal(9,6);
      Longitude        : Decimal(9,6);

      @cds.persistence.name : 'IcaoCode'
      ICAOCode         : String(4);

      @cds.persistence.name : 'Type'
      AirportType      : String(40);

      Municipality     : String(120);
      ElevationFt      : Integer;
      IsoRegion        : String(10);
      GpsCode          : String(10);
      ScheduledService : String(3);
}

entity Connections {
  key CarrierID    : String(3);   // /dmo/carrier_id
  key ConnectionID : String(4);   // /dmo/connection_id
  AirportFromID    : String(3);
  AirportToID      : String(3);
  DepartureTime    : String(8);   // keep simple; later time type if you want
  ArrivalTime      : String(8);
  Distance         : Integer;
  DistanceUnit     : String(3);   // msehi
}

entity Flights {
  key CarrierID    : String(3);
  key ConnectionID : String(4);
  key FlightDate   : Date;
  Price            : Decimal(15,2);
  CurrencyCode     : String(3);
  PlaneTypeID      : String(10);
  SeatsMax         : Integer;
  SeatsOccupied    : Integer;
}

entity Customers {
  key CustomerID   : String(10);
  FirstName        : String(40);
  LastName         : String(40);
  Title            : String(10);
  Street           : String(60);
  PostalCode       : String(10);
  City             : String(60);
  CountryCode      : String(3);
  PhoneNumber      : String(30);
  EmailAddress     : String(80);
}

entity Agencies {
  key AgencyID     : String(10);
  Name             : String(60);
  Street           : String(60);
  PostalCode       : String(10);
  City             : String(60);
  CountryCode      : String(3);
  PhoneNumber      : String(30);
  EmailAddress     : String(80);
  WebAddress       : String(120);
}

entity Travels {
  key TravelID     : String(10);
  AgencyID         : String(10);
  CustomerID       : String(10);
  BeginDate        : Date;
  EndDate          : Date;
  BookingFee       : Decimal(15,2);
  TotalPrice       : Decimal(15,2);
  CurrencyCode     : String(3);
  Description      : String(120);
  Status           : String(20);
}

entity Bookings {
  key TravelID      : String(10);
  key BookingID     : String(10);
  BookingDate       : Date;
  CustomerID        : String(10);
  CarrierID         : String(3);
  ConnectionID      : String(4);
  FlightDate        : Date;
  FlightPrice       : Decimal(15,2);
  CurrencyCode      : String(3);
}