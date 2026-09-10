# SAP BTP Travel Expense Intelligence

> **Explainable Receipt Validation and Airfare Cost Assessment**

## Portfolio summary

**SAP BTP Travel Expense Intelligence** is an explainable SAP full-stack portfolio project built with SAP CAP and SAPUI5. It converts travel receipt PDFs into structured business data, supports human correction, validates required fields and financial consistency, matches the validated receipt with SAP travel and booking reference data, and produces both a currency-normalized draft posting proposal and an evidence-aware airfare Cost Assessment.

The key design choice is the separation of probabilistic extraction from deterministic business logic. Gemini or OpenAI structures the receipt text, while CAP services validate the extracted result, perform Travel Data Matching across Travel, Booking, Flight, Connection and Airport records, and apply deterministic benchmark and integrity rules before a business decision is shown.

The travel reference layer is based on SAP DMO sample data exposed from SAP BTP ABAP Environment through OData V4. For reproducible development and testing, the relevant reference data is replicated into a local CAP data layer that can run with SQLite. Airport records are enriched with geographic coordinates to support nearby-airport benchmark scenarios.

I designed and implemented the prototype end to end: ABAP CDS/OData V4 source preparation, data export, CAP services, CDS modeling, LLM and FX adapters, receipt validation, Travel Data Matching, airfare benchmarking, geo enrichment, a freestyle SAPUI5 review workbench, and automated unit/integration tests. The current portfolio solution also demonstrates deployment on SAP BTP Cloud Foundry with SAP HANA Cloud persistence through HDI.

## Demo videos

### Project Overview

**SAP BTP Travel Expense Intelligence — Project Overview**  
https://www.youtube.com/watch?v=Hjye6RPOxQo

- [00:00 — Project Overview & Business Problem](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=0s)
- [00:19 — Solution & Receipt Processing](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=19s)
- [00:51 — Travel Data Matching & Cost Assessment](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=51s)
- [01:13 — Posting Proposal & Technology Stack](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=73s)

### Technical Workflow

**SAP BTP Travel Expense Intelligence — Technical Workflow**  
https://youtu.be/rPoYeKcS0Ic

- [00:00 — Overview & Final Cost Assessment](https://youtu.be/rPoYeKcS0Ic?t=0)
- [00:17 — Architecture](https://youtu.be/rPoYeKcS0Ic?t=17)
- [03:28 — Upload & Ingestion](https://youtu.be/rPoYeKcS0Ic?t=208)
- [04:38 — AI Extraction](https://youtu.be/rPoYeKcS0Ic?t=278)
- [05:58 — Correction & Validation](https://youtu.be/rPoYeKcS0Ic?t=358)
- [07:07 — Travel Data Matching](https://youtu.be/rPoYeKcS0Ic?t=427)
- [08:01 — Financial Flow](https://youtu.be/rPoYeKcS0Ic?t=481)
- [09:46 — Cost Assessment](https://youtu.be/rPoYeKcS0Ic?t=586)
- [12:58 — Testing](https://youtu.be/rPoYeKcS0Ic?t=778)
- [15:27 — Roadmap & Conclusion](https://youtu.be/rPoYeKcS0Ic?t=927)
- [15:40 — Final Architecture](https://youtu.be/rPoYeKcS0Ic?t=940)

## Relevant technologies

SAP BTP, SAP CAP for Node.js, CDS, OData V4, SAPUI5, JavaScript, SQLite, SAP HANA Cloud, HDI, Cloud Foundry, SAP BTP ABAP Environment, ABAP/RAP service binding, Gemini/OpenAI, REST APIs, Frankfurter/ECB reference rates, Git.

## Testing

The repository contains isolated unit tests for deterministic validation logic and integration tests that start the CAP application with `cds.test`, use an in-memory database, call real CAP OData endpoints, and verify both returned results and persisted workflow states. Negative scenarios are included as well.

## Scope and limitations

This is a decision-support portfolio prototype, not a live airline shopping or historical fare-availability engine. The travel reference layer is based on SAP DMO/local sample data and therefore cannot prove which fares were actually available at the original booking moment. The financial workflow prepares a transparent draft posting proposal; it does not create an SAP FI document or execute an ERP posting.

The current BTP deployment demonstrates the application architecture, while production-grade authentication and role-based authorization, CI/CD, a stable live SAP Destination, audit logging and an approved ERP posting integration remain roadmap items.

## Target roles

Junior SAP BTP Full-Stack Developer, SAP CAP & UI5 Developer, Junior SAP Cloud Developer, Technical Consultant, or product-oriented SAP BTP Developer.
