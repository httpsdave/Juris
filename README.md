# Juris

A legal discovery platform for Philippine laws. Solves the fragmentation problem: laws scattered across multiple official portals, outdated mirrors, and inconsistent formats. Juris aggregates, searches, and displays Philippine legal sources with source transparency and freshness indicators.

## Why This Matters

Philippine laws are published across multiple portals (Official Gazette, Congress, judiciary databases, legal repositories). Researchers, students, and citizens spend hours searching fragmented sources. Juris centralizes this into one searchable platform with clear source attribution.

## What It Does

- **Search across all sources** — Find any Philippine law, decree, or issuance in one place.
- **Know the source** — See where each law came from (official gazette, congress API, judiciary database, etc.). Understand if it's an official publication or a community mirror.
- **Read with context** — View full text with embedded source documents (PDFs where available). Track publication dates and authority levels.
- **Aggregate intelligently** — Deduplicates and ranks records by freshness and authority. Prioritizes official versions over mirrors.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Framework** | Next.js 16 (App Router) + TypeScript |
| **UI** | React + Tailwind CSS |
| **Scraping** | Node.js + Cheerio |
| **Data** | JSON (in-memory indexing) |
| **PDF Processing** | pdf-parse library |

## Data Sources

Currently ingests from:
- Open Congress API (official congressional records)
- Official Gazette (RSS + web scraping)
- Judiciary e-Library (court decisions and documents)
- LawPhil and ChanRobles (legal databases)

See [docs/data-sources.md](docs/data-sources.md) for source details and accuracy notes.

## Accuracy & Transparency

- All records include source URL and publication date.
- Multiple versions of the same law are merged intelligently; official sources take precedence.
- Blocked sources (e.g., HTTP 403) are flagged, not hidden.
- Noisy or low-confidence text is automatically filtered.
