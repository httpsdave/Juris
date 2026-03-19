# Juris Data Sources (Philippine Law)

## Summary

Juris uses a mixed-source ingestion strategy:

- API-first where structured endpoints exist.
- Scraping for legacy HTML sources.
- Source confidence metadata shown in the UI.
- Primary publications prioritized for legal authority.

## Source Assessment

| Source | URL | Access Mode | Official | Observed Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Lawphil Project | https://lawphil.net/ | Scrape | No | 200 HTML | Broad legal corpus, legacy HTML structure, no public API observed. |
| Official Gazette | https://www.officialgazette.gov.ph/ | Scrape/Hybrid | Yes | 200 HTML + embedded PDFs | Republic Acts and issuances often embed signed PDF files; scraper captures both listing metadata and source PDF links/text when available. |
| ChanRobles Virtual Law Library | https://chanrobles.com/virtualibrary1.htm | Scrape | No | 200 HTML | Rich topic-index navigation, useful for discovery, verify against primary sources. |
| Congress legislative portal | https://www.congress.gov.ph/legis/ | Scrape | Yes | 403 for non-browser automation | Important bill source but may block automated requests; requires resilient crawler strategy. |
| Supreme Court E-Library | https://elibrary.judiciary.gov.ph/republic_acts | Scrape | Yes | 200 HTML | Republic Acts listed in table format with large entry volume. |
| Open Congress API | https://open-congress-api.bettergov.ph/api/scalar | API | No (community project) | 200 API | Structured API with OpenAPI spec and bill/people/congress endpoints. |

## Open Congress API Endpoints (Verified)

OpenAPI spec endpoint:

- https://open-congress-api.bettergov.ph/api/doc

Important paths observed in spec:

- /congresses
- /congresses/{id}
- /congresses/{id}/documents
- /people
- /people/{id}
- /people/{id}/groups
- /people/{id}/documents
- /documents
- /documents/{id}
- /documents/{id}/authors
- /search/people
- /search/documents
- /stats
- /ping

## Ingestion Policy

1. Prioritize official sources for canonical text and signing/publication metadata.
2. Use Lawphil and ChanRobles primarily for discoverability and cross-references.
3. Tag each record with:
   - source
   - freshness (fresh, stale, blocked, api)
   - authority score
   - last verified timestamp
4. If a source is blocked (for example HTTP 403), mark it blocked in data instead of silently dropping it.

## Notes on Accuracy

- Open Congress data is highly useful for metadata and discovery but should be cross-checked with official publications for final legal citation.
- Community-maintained and mirrored libraries are helpful, but Juris should always surface source provenance for trust.
