using { demo.copilot as db } from '../db/schema';

service CopilotService {

  // ---------------------------------------------------------------------------
  // 1. Core application entities
  // Persistent receipt workflow data and the local FX-rate cache.
  // ---------------------------------------------------------------------------
  entity Receipts as projection on db.Receipt;
  entity FxRates  as projection on db.FxRateCache;

  // ---------------------------------------------------------------------------
  // 2. Receipt ingestion and AI extraction
  // Upload stores the receipt; extraction turns stored text into structured data.
  // ---------------------------------------------------------------------------
  action uploadReceipt(fileName: String, mimeType: String, base64: LargeString) returns Receipts;
  action extract(receiptId: cds.UUID) returns Receipts;

  // ---------------------------------------------------------------------------
  // 3. Correction, validation and DMO matching
  // Deterministic checks stay separate from AI extraction.
  // ---------------------------------------------------------------------------
  action matchDMO(receiptId: cds.UUID) returns LargeString;
  action validate(receiptId: cds.UUID) returns LargeString;

  action updateExtractedReceipt(
    receiptId: cds.UUID,
    extractedJson: LargeString
    ) returns {
      updated: Boolean;
      receiptId: cds.UUID;
    };

  // ---------------------------------------------------------------------------
  // 4. Foreign exchange and posting proposal
  // Financial output is proposed only; no ERP/FI posting is performed here.
  // ---------------------------------------------------------------------------
  type FxConversionResult {
    rateDate      : Date;
    base          : String(3);
    symbol        : String(3);
    original      : Decimal(15,2);
    rate          : Decimal(15,5);
    converted     : Decimal(15,2);
    source        : String(100);
    effectiveDate : Date;
  }

  action convertFx(
    receiptId  : cds.UUID,
    toCurrency : String(3)
  ) returns FxConversionResult;

  type PostingLine {
    type           : String(40);
    description    : String(255);
    amount         : Decimal(15,2);
    amountPosting  : Decimal(15,2);
    currency       : String(3);
    postingCurrency: String(3);
    carrierId      : String(10);
    connectionId   : String(20);
    bookingId      : String(20);
    flightDate     : Date;
  }

  type PostingProposal {
    receiptNo        : String(50);
    receiptDate      : Date;
    travelId         : String(20);
    supplier         : String(255);
    currencyOriginal : String(3);
    totalOriginal    : Decimal(15,2);
    airfareOriginal  : Decimal(15,2);
    nonAirfareOriginal : Decimal(15,2);
    postingCurrency  : String(3);
    totalPosting     : Decimal(15,2);
    airfarePosting   : Decimal(15,2);
    nonAirfarePosting: Decimal(15,2);
    totalScope       : String(200);
    lines            : many PostingLine;
    fx               : FxConversionResult;
  }

  action postingProposal(
    receiptId: cds.UUID,
    postingCurrency: String(3)
  ) returns PostingProposal;

  // ---------------------------------------------------------------------------
  // 5. Cost-efficiency assessment
  // Types below form the structured API response for benchmarking and decisions.
  // ---------------------------------------------------------------------------
  type AlternativeFlight {
    carrierId    : String(10);
    connectionId : String(20);
    flightDate   : Date;
    routeFrom    : String(10);
    routeTo      : String(10);
    price        : Decimal(15,2);
    currency     : String(3);
    scope        : String(20);
  }

   type CostEfficiencyAlternative {
    carrierId            : String(10);
    connectionId         : String(20);
    flightDate           : Date;
    routeFrom            : String(10);
    routeTo              : String(10);

    // price/currency are shown in the selected decision currency.
    price                : Decimal(15,2);
    currency             : String(3);

    // Original price before FX conversion, kept for transparency.
    priceSource          : Decimal(15,2);
    sourceCurrency       : String(3);
    scope                : String(20);
  }


  type CostEfficiencyDecision {
    currency          : String(3);
    selectedTotal     : Decimal(15,2);
    benchmarkTotal    : Decimal(15,2);
    difference        : Decimal(15,2);
    differencePercent : Decimal(9,2);
    status            : String(30);
    basis             : String(500);
    rateDate          : Date;
    rate              : Decimal(15,5);
  }

  type CostEfficiencyCurrencyContext {
    sourceCurrency    : String(3);
    decisionCurrency  : String(3);
    decisionDate      : Date;
    fxRateDate        : Date;
    fxRate            : Decimal(15,5);
    fxSource          : String(100);
    decisionMeaning   : String(500);
  }

  type CostEfficiencyLine {
    bookingId            : String(20);
    carrierId            : String(10);
    flightDate           : Date;
    routeFrom            : String(10);
    routeTo              : String(10);
    sourceCurrency       : String(3);
    decisionCurrency     : String(3);

    // Values in original purchase / DMO currency.
    selectedPriceSource        : Decimal(15,2);
    benchmarkPriceSource       : Decimal(15,2);
    benchmarkMedianPriceSource : Decimal(15,2);

    // Values in selected decision currency.
    selectedPrice        : Decimal(15,2);
    benchmarkPrice       : Decimal(15,2);
    benchmarkMedianPrice : Decimal(15,2);

    comparableCount      : Integer;
    benchmarkMode        : String(20);
    benchmarkStrength    : String(20);

    // Source status = original currency decision.
    // Status / decisionStatus = selected decision currency decision.
    sourceStatus         : String(30);
    decisionStatus       : String(30);
    status               : String(30);
    rationale            : String(1000);
    benchmarkAlternative : CostEfficiencyAlternative;
    cheapestAlternative  : CostEfficiencyAlternative;
    referenceAlternative : CostEfficiencyAlternative;
    allAlternatives      : many CostEfficiencyAlternative;
    alternatives         : many CostEfficiencyAlternative;
  }

  type CostEfficiencyAssessment {
    receiptId                : cds.UUID;
    travelId                 : String(20);
    bookingCurrency          : String(3);
    sourceCurrency           : String(3);
    decisionCurrency         : String(3);

    // Original purchase / DMO currency values.
    selectedTotalSource      : Decimal(15,2);
    benchmarkTotalSource     : Decimal(15,2);
    fullReceiptTotalSource   : Decimal(15,2);
    nonAirfareTotalSource    : Decimal(15,2);

    // Selected decision currency values.
    selectedTotal            : Decimal(15,2);
    benchmarkTotal           : Decimal(15,2);
    fullReceiptTotal         : Decimal(15,2);
    nonAirfareTotal          : Decimal(15,2);

    sourceOverallStatus      : String(30);
    overallStatus            : String(30);
    sourceCurrencyDecision   : CostEfficiencyDecision;
    decisionCurrencyDecision : CostEfficiencyDecision;
    currencyContext          : CostEfficiencyCurrencyContext;
    benchmarkStrength        : String(20);
    benchmarkMode            : String(20);
    benchmarkScope           : String(500);
    rationale                : String(2000);
    lines                    : many CostEfficiencyLine;
  }
  


  // ---------------------------------------------------------------------------
  // 6. Expanded opportunity search
  // Nearby-airport and date-window alternatives used for cheaper-route scenarios.
  // ---------------------------------------------------------------------------
  type OpportunityNearbyAirport {
    role              : String(20);
    sourceAirportId   : String(10);
    sourceLatitude    : Decimal(15,7);
    sourceLongitude   : Decimal(15,7);
    airportId         : String(10);
    name              : String(255);
    city              : String(120);
    country           : String(120);
    latitude          : Decimal(15,7);
    longitude         : Decimal(15,7);
    distanceKm        : Decimal(10,2);
  }

  type OpportunityAlternative {
    carrierId              : String(10);
    connectionId           : String(20);
    flightDate             : Date;
    routeFrom              : String(10);
    routeTo                : String(10);
    sourceCurrency         : String(3);
    decisionCurrency       : String(3);
    pricePerPassengerSource: Decimal(15,2);
    pricePerPassenger      : Decimal(15,2);
    passengerCount         : Integer;
    flightTotalSource      : Decimal(15,2);
    flightTotal            : Decimal(15,2);
    airportChanges         : Integer;
    originChanged          : Boolean;
    destinationChanged     : Boolean;
    originDistanceKm       : Decimal(10,2);
    destinationDistanceKm  : Decimal(10,2);
    estimatedExtraCost     : Decimal(15,2);
    adjustedTotal          : Decimal(15,2);
    grossSaving            : Decimal(15,2);
    netSaving              : Decimal(15,2);
    netSavingPercent       : Decimal(9,2);
    dateOffsetDays         : Integer;
    scope                  : String(40);
  }

  type OpportunityLeg {
    legKey                 : String(40);
    legNumber              : Integer;
    bookingIdsText         : String(500);
    originalCarrierId      : String(10);
    originalConnectionId   : String(20);
    flightDate             : Date;
    originalRouteFrom      : String(10);
    originalRouteTo        : String(10);
    passengerCount         : Integer;
    sourceCurrency         : String(3);
    decisionCurrency       : String(3);
    selectedTotalSource    : Decimal(15,2);
    selectedTotal          : Decimal(15,2);
    nearbyOriginCount      : Integer;
    nearbyDestinationCount : Integer;
    alternativeCount       : Integer;
    status                 : String(40);
    message                : String(1000);
    bestAlternative        : OpportunityAlternative;
    alternatives           : many OpportunityAlternative;
  }

  type OpportunityWarning {
    text : String(1000);
  }

  type CheaperOpportunityAssessment {
    receiptId                 : cds.UUID;
    travelId                  : String(20);
    sourceCurrency            : String(3);
    decisionCurrency          : String(3);
    overallStatus             : String(40);
    assessmentCompleteness    : String(30);
    mainDecisionImpact        : String(20);
    mainDecisionMessage       : String(1000);
    overallMessage            : String(2000);
    evidenceLimit             : String(2000);
    radiusKm                  : Decimal(10,2);
    expandedWindowDays        : Integer;
    airportChangePenalty      : Decimal(15,2);
    minimumNetSavingAmount    : Decimal(15,2);
    minimumNetSavingPercent   : Decimal(9,2);
    checkedLegCount           : Integer;
    materialOpportunityCount  : Integer;
    positiveOpportunityCount  : Integer;
    nearbyAirportCount        : Integer;
    searchedCandidateCount    : Integer;
    passengerSelectionBasis   : String(60);
    fxRate                    : Decimal(15,5);
    fxRateDate                : Date;
    fxSource                  : String(100);
    nearbyAirports            : many OpportunityNearbyAirport;
    legs                      : many OpportunityLeg;
    warnings                  : many OpportunityWarning;
  }

  action checkCheaperOpportunities(
    receiptId               : cds.UUID,
    nearbyRadiusKm          : Integer,
    expandedWindowDays      : Integer,
    decisionCurrency        : String(3),
    airportChangePenalty    : Decimal(15,2),
    minimumNetSavingAmount  : Decimal(15,2),
    minimumNetSavingPercent : Decimal(9,2)
  ) returns CheaperOpportunityAssessment;

  action assessCostEfficiency(
    receiptId          : cds.UUID,
    benchmarkExpansionThreshold : Integer,
    expandedWindowDays : Integer,
    nearbyRadiusKm     : Integer,
    acceptableThresholdPercent: Integer,
    decisionCurrency   : String(3)
  ) returns CostEfficiencyAssessment;

  // ---------------------------------------------------------------------------
  // 7. Receipt lifecycle
  // ---------------------------------------------------------------------------
  action deleteReceipt(receiptId : cds.UUID) returns {
      deleted: Boolean;
      receiptId: UUID;
  }


  // ---------------------------------------------------------------------------
  // 8. Technical / diagnostic actions
  // Kept outside the core business walkthrough.
  // ---------------------------------------------------------------------------
  action debugRequires() returns array of String;
  action chat(receiptId: cds.UUID, question: String) returns String;
  action abapPing() returns String;

}