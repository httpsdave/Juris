import type { LawRecord } from "../../types/law";

import { nowIso, ScrapeResult, toLawId } from "./shared";

const SOURCE_URL = "https://www.congress.gov.ph/legis/";

export async function scrapeCongressPortal(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });

    const records: LawRecord[] = [];

    if (response.status === 403) {
      warnings.push("Congress portal returned HTTP 403. Marked as blocked for automated crawling.");

      records.push({
        id: toLawId("congress", "blocked"),
        title: "Congress Legislative Portal accessibility",
        category: "bill",
        summary:
          "Automated access is currently blocked with HTTP 403. Juris marks this source as blocked and retries in later ingestion runs.",
        source: "congress",
        sourceUrl: SOURCE_URL,
        tags: ["congress", "access", "blocked"],
        isPrimarySource: true,
        freshness: "blocked",
        lastVerifiedAt: nowIso(),
        authorityLevel: 88,
      });

      return {
        source: "congress",
        records,
        warnings,
      };
    }

    if (!response.ok) {
      warnings.push(`Congress portal responded with status ${response.status}.`);

      return {
        source: "congress",
        records,
        warnings,
      };
    }

    warnings.push(
      "Congress portal responded without 403. Add HTML parsing selectors for titles and bill metadata when access stabilizes.",
    );

    return {
      source: "congress",
      records,
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "congress",
      records: [],
      warnings,
    };
  }
}
