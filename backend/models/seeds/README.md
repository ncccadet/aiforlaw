# Seeds

## job_sources.seed.sql (to be generated)
The 721+ curated URLs (Supreme Court, 26 High Courts, 677 district courts via
districts.ecourts.gov.in, NALSA, Bar Council, SLSAs, law firms, portals — see
`court_links.pdf` and `VFL_Law_Job_Internship_Sites` PDF) get loaded into the
`job_sources` table as INSERT statements, extracted from the PDFs' literal text
(PyMuPDF) — never slug-guessing.

Rules:
- One INSERT per source with `category` and `scrape_method` set.
- Naukri/LinkedIn/Indeed → `scrape_method='api_*'` or `apify` (they block direct scraping).
- Gov/court sites that publish notices as PDFs → note it; PDF parsing happens in the worker, never the API process (P004).
- Re-runnable: `ON CONFLICT (url) DO NOTHING`.
