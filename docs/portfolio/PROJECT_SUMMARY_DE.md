# SAP BTP Travel Expense Intelligence

> **Nachvollziehbare Reisebelegvalidierung und Flugkostenbewertung**

## Kurzbeschreibung für Portfolio und HR

**SAP BTP Travel Expense Intelligence** ist ein nachvollziehbares SAP-Full-Stack-Portfolio-Projekt auf Basis von SAP CAP und SAPUI5. Die Anwendung überführt Reisebeleg-PDFs in strukturierte Geschäftsdaten, ermöglicht manuelle Korrekturen, validiert Pflichtfelder und finanzielle Konsistenz, gleicht den validierten Beleg mit SAP-Reise- und Buchungsreferenzdaten ab und erstellt sowohl einen währungsnormalisierten Entwurf für einen Buchungsvorschlag als auch ein evidenzbasiertes Cost Assessment der Flugkosten.

Der zentrale Architekturgedanke ist die Trennung von probabilistischer KI-Extraktion und deterministischer Geschäftslogik. Gemini oder OpenAI strukturieren den Belegtext, während CAP-Services das extrahierte Ergebnis validieren, Travel Data Matching über Travel-, Booking-, Flight-, Connection- und Airport-Daten durchführen und anschließend deterministische Benchmark- und Integritätsregeln anwenden, bevor eine Geschäftsentscheidung angezeigt wird.

Die Reisereferenzschicht basiert auf SAP-DMO-Beispieldaten, die aus der SAP BTP ABAP Environment über OData V4 bereitgestellt werden. Für reproduzierbare Entwicklung und Tests werden die relevanten Referenzdaten in eine lokale CAP-Datenschicht repliziert, die mit SQLite betrieben werden kann. Die Flughafendaten wurden zusätzlich um geografische Koordinaten erweitert, um Benchmark-Szenarien mit nahegelegenen Flughäfen zu unterstützen.

Ich habe den Prototypen als End-to-End-Lösung konzipiert und umgesetzt: von ABAP CDS/OData-V4-Datenbereitstellung und Datenexport über CAP-Services, CDS-Modellierung, LLM- und FX-Adapter, Belegvalidierung, Travel Data Matching, Flugpreis-Benchmarking und Geo-Anreicherung bis zur Freestyle-SAPUI5-Workbench und automatisierten Unit-/Integrationstests. Die aktuelle Portfolio-Lösung demonstriert außerdem ein Deployment auf SAP BTP Cloud Foundry mit persistenter Datenhaltung in SAP HANA Cloud über HDI.

## Demo-Videos

### Projektübersicht

**SAP BTP Travel Expense Intelligence — Project Overview**  
https://www.youtube.com/watch?v=Hjye6RPOxQo

- [00:00 — Projektübersicht & Business Problem](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=0s)
- [00:19 — Lösung & Belegverarbeitung](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=19s)
- [00:51 — Travel Data Matching & Cost Assessment](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=51s)
- [01:13 — Posting Proposal & Technologie-Stack](https://www.youtube.com/watch?v=Hjye6RPOxQo&t=73s)

### Technischer Workflow

**SAP BTP Travel Expense Intelligence — Technical Workflow**  
https://youtu.be/rPoYeKcS0Ic

- [00:00 — Überblick & finales Cost Assessment](https://youtu.be/rPoYeKcS0Ic?t=0)
- [00:17 — Architektur](https://youtu.be/rPoYeKcS0Ic?t=17)
- [03:28 — Upload & Ingestion](https://youtu.be/rPoYeKcS0Ic?t=208)
- [04:38 — KI-Extraktion](https://youtu.be/rPoYeKcS0Ic?t=278)
- [05:58 — Korrektur & Validierung](https://youtu.be/rPoYeKcS0Ic?t=358)
- [07:07 — Travel Data Matching](https://youtu.be/rPoYeKcS0Ic?t=427)
- [08:01 — Financial Flow](https://youtu.be/rPoYeKcS0Ic?t=481)
- [09:46 — Cost Assessment](https://youtu.be/rPoYeKcS0Ic?t=586)
- [12:58 — Testing](https://youtu.be/rPoYeKcS0Ic?t=778)
- [15:27 — Roadmap & Fazit](https://youtu.be/rPoYeKcS0Ic?t=927)
- [15:40 — Finale Architektur](https://youtu.be/rPoYeKcS0Ic?t=940)

## Relevante Technologien

SAP BTP, SAP CAP für Node.js, CDS, OData V4, SAPUI5, JavaScript, SQLite, SAP HANA Cloud, HDI, Cloud Foundry, SAP BTP ABAP Environment, ABAP/RAP Service Binding, Gemini/OpenAI, REST APIs, Frankfurter/EZB-Referenzkurse, Git.

## Testing

Das Repository enthält isolierte Unit-Tests für die deterministische Validierungslogik sowie Integrationstests, die die CAP-Anwendung mit `cds.test` starten, eine In-Memory-Datenbank verwenden, echte CAP-OData-Endpunkte aufrufen und sowohl Rückgabewerte als auch persistierte Workflow-Status prüfen. Auch negative Szenarien sind enthalten.

## Ehrliche Abgrenzung

Das Projekt ist ein entscheidungsunterstützender Portfolio-Prototyp und keine Live-Flugsuche oder historische Fare-Availability-Engine. Die Reisereferenzschicht basiert auf SAP-DMO-/lokalen Beispieldaten und kann daher nicht beweisen, welche Flugpreise zum ursprünglichen Buchungszeitpunkt tatsächlich verfügbar waren. Der Financial Flow erstellt einen transparenten Entwurf für einen Buchungsvorschlag; er erzeugt kein SAP-FI-Dokument und führt kein ERP-Posting aus.

Das aktuelle BTP-Deployment demonstriert die Anwendungsarchitektur. Produktive Authentifizierung und rollenbasierte Autorisierung, CI/CD, eine stabile Live-SAP-Destination, Audit Logging und eine freigegebene ERP-Posting-Integration bleiben Roadmap-Themen.

## Geeignete Zielrollen

Junior SAP BTP Full-Stack Developer, SAP CAP & UI5 Developer, Junior SAP Cloud Developer, Technical Consultant oder product-oriented SAP BTP Developer.
