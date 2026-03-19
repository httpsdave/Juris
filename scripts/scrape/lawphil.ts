import type { LawCategory, LawRecord } from "../../types/law";

import {
  absoluteUrl,
  enrichRecordsWithArticleText,
  fetchDom,
  nowIso,
  safeText,
  ScrapeResult,
  toLawId,
} from "./shared";

const SOURCE_URL = "https://lawphil.net/";

function inferCategory(title: string): LawCategory {
  if (/constitution/i.test(title)) {
    return "constitution";
  }

  if (/republic act|act no\.?|commonwealth/i.test(title)) {
    return "republic_act";
  }

  if (/code|penal|civil|labor|tax/i.test(title)) {
    return "code";
  }

  if (/rules|rule of court/i.test(title)) {
    return "rule";
  }

  if (/decision|jurisprudence/i.test(title)) {
    return "jurisprudence";
  }

  return "other";
}

export async function scrapeLawphil(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  try {
    const $ = await fetchDom(SOURCE_URL);
    const records: LawRecord[] = [];
    const seen = new Set<string>();

    $("a").each((_, element) => {
      const anchor = $(element);
      const title = safeText(anchor);
      const href = absoluteUrl(SOURCE_URL, anchor.attr("href"));

      if (!title || !href.includes("lawphil.net")) {
        return;
      }

      if (!/constitution|act|code|rules|jurisprudence|court|decree|issuance/i.test(title)) {
        return;
      }

      const key = `${title.toLowerCase()}::${href}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);

      records.push({
        id: toLawId("lawphil", title),
        title,
        category: inferCategory(title),
        summary: `Discovered from Lawphil navigation and legal index: ${title}`,
        source: "lawphil",
        sourceUrl: href,
        tags: ["lawphil", "legacy library", "legal reference"],
        fullTextPreview: "Lawphil index entry for Philippine legal resources.",
        isPrimarySource: false,
        freshness: "stale",
        lastVerifiedAt: nowIso(),
        authorityLevel: 82,
      });
    });

    if (!records.length) {
      warnings.push("No records parsed from Lawphil anchors.");
    }

    if (records.length) {
      await enrichRecordsWithArticleText(records, {
        warnings,
        sourceLabel: "lawphil",
        maxRecords: 60,
        minTextLength: 220,
        maxTextLength: 24000,
      });
    }

    return {
      source: "lawphil",
      records: records.slice(0, 120),
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "lawphil",
      records: [],
      warnings,
    };
  }
}
