# SOURCES.md

Status vocabulary: **allowed** (terms reviewed, safe to use), **needs review** (feasible, but the owner must read the terms and mark them reviewed before ingestion runs), **blocked** (do not use).
Ingestion code enforces this: a source with no `terms_reviewed_at` is skipped, and a source that fails three runs in a row is auto-disabled. Last reviewed by the builder: 2026-10-11.

## In the product today

| Source | Owner | Access method | Terms | Commercial use / summaries | Cadence | Fields used | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| City of Mesa commercial building permits | City of Mesa | Socrata open-data JSON API, dataset `m2kk-w2hz` on data.mesaaz.gov, filtered to `permit_type='COM'`, last 60 days plus in-review | https://data.mesaaz.gov/stories/s/Terms-of-Use-page/2dcd-j2nx/ (Data Policy: https://data.mesaaz.gov/stories/s/72r3-uevs/) | **Unknown.** The builder could not read the terms text (JavaScript-rendered page). Open-data portals generally permit reuse, but that is not verified here. | Daily 04:00 AZ | permit number, type, status, issued date, description, address, valuation, contractor business name | **needs review** |
| City of Phoenix current permits | City of Phoenix | ArcGIS REST layer `Planning_Permit/MapServer/1`, open permits issued in last 45 days | Not located. Check the City's open-data terms or ask the data team. | **Unknown** | Daily | permit number, project, scope, type, issue date, street name, professional name (labelled "applicant", not GC) | **needs review** |
| SAM.gov Opportunities API | GSA (federal) | REST API v2, one request per run, `state=AZ`, last 14 days, key required | https://open.gsa.gov/api/get-opportunities-public-api/ | Federal opportunity notices are public. The API page states per-day limits depend on role but gives no numbers; BuildSignal makes 1 request/day and treats HTTP 429 as "rate limited", not "broken". | Daily | notice ID, title, agency, NAICS, response deadline, set-aside, link | **needs review** (and needs `SAM_API_KEY`) |

Notes on fields:
- The Mesa dataset has no ZIP column, so ZIP is shown as "unconfirmed" in the checklist rather than guessed.
- Permit valuations are what the applicant reported for fees. They are not contract prices, and every digest says so.
- Contractor names are business names from the permit. No property-owner names are ingested or stored. No residential permits are ingested.
- We link to the official record for every item and never host solicitation documents.

## Customer-forwarded alert emails (inbox feature; ships OFF)

| Source | Owner | Access method | Terms | Commercial use / summaries | Cadence | Fields used | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Alert emails a customer forwards from their own BidNet / state portal / PlanHub / BuildingConnected / other subscriptions | The customer (who is the recipient of the alert) | Customer forwards to a private address; Resend inbound webhook `email.received`, body fetched via Resend API. No portal is contacted, scraped or logged into. Links inside emails are displayed (labelled by host) but never fetched; attachments are never downloaded. | Each portal's vendor terms may restrict how its alert content is used or shared. **Not reviewed**: the builder has not seen those terms. | Items are shown only back to the customer who forwarded them, never to others and never in public pages, so redistribution is not involved. Whether a portal's terms forbid forwarding to a third-party processor is an open question for the attorney (OWNER-TODO). | Whenever the customer forwards | subject and text, 30-day retention; extracted title, agency, deadline, link, value | **needs review** (do not enable for customers until terms and T13 are checked) |

## Not built, and why

| Source | Reason | Status |
| --- | --- | --- |
| Arizona Procurement Portal (state) | Brief says verify terms first; no official API or feed was verified. Customers can forward their own alert emails (see the forwarded-inbox row below; ships off). | not built |
| Maricopa County / BidNet Direct | Commercial platform; terms not verified. Do not scrape. | blocked until reviewed |
| Other cities, school districts, ADOT, Valley Metro, housing authorities | Not mapped yet. Adding one = one adapter file in `src/adapters/` plus a row in `source_config`. | not built |
| ROC (Registrar of Contractors) lookup | No official API or bulk file known; automated access terms unknown. Never scrape. Licence numbers are self-reported and shown "unverified"; a link to roc.az.gov helps the customer check. | blocked (assisted only) |
| BuildingConnected, Procore, PlanHub and similar | Private invitations. Never scrape or log in on anyone's behalf. | blocked |
| County Assessor owner data | Commercial-use restrictions (A.R.S. 39-121.03). Not used. | blocked |
| Homeowner / residential permit leads | Out of scope until a lawyer reviews. | not built |

## Re-verification
Terms change. Calendar item: re-read each source's terms every quarter and whenever Admin > Sources shows a format change. Update `terms_reviewed_at` in the admin screen when you do.

## Public demo data
The demo on the landing page uses 10 real permit records (Mesa and Scottsdale) from a research snapshot taken for this build, stored in `src/sample.js` and labelled "Sample snapshot". It is not fetched live and each item links to its official record.
