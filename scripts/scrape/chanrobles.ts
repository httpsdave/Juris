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

const SOURCE_URL = "https://chanrobles.com/virtualibrary1.htm";

function inferCategory(title: string): LawCategory {
  if (/jurisprudence|supreme court/i.test(title)) {
    return "jurisprudence";
  }

  if (/code|civil|criminal|labor|tax|mercantile/i.test(title)) {
    return "code";
  }

  if (/constitutional|constitution/i.test(title)) {
    return "constitution";
  }

  return "other";
}

export async function scrapeChanrobles(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  try {
    const $ = await fetchDom(SOURCE_URL);
    const records: LawRecord[] = [];
    const seen = new Set<string>();

    $("a").each((_, element) => {
      const anchor = $(element);
      const title = safeText(anchor);
      const href = absoluteUrl(SOURCE_URL, anchor.attr("href"));

      if (!title || !href.includes("chanrobles.com")) {
        return;
      }

      if (!/law|code|jurisprudence|supreme court|philippine/i.test(title)) {
        return;
      }

      const key = `${title.toLowerCase()}::${href}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);

      records.push({
        id: toLawId("chanrobles", title),
        title,
        category: inferCategory(title),
        summary: `Topic index entry from ChanRobles Virtual Law Library: ${title}`,
        source: "chanrobles",
        sourceUrl: href,
        tags: ["chanrobles", "topic index", "legacy html"],
        fullTextPreview: "ChanRobles index link discovered in public virtual law library.",
        isPrimarySource: false,
        freshness: "stale",
        lastVerifiedAt: nowIso(),
        authorityLevel: 72,
      });
    });

    if (!records.length) {
      warnings.push("No records parsed from ChanRobles anchors.");
    }

    if (records.length) {
      await enrichRecordsWithArticleText(records, {
        warnings,
        sourceLabel: "chanrobles",
        maxRecords: 60,
        minTextLength: 220,
        maxTextLength: 22000,
      });
    }

    return {
      source: "chanrobles",
      records: records.slice(0, 120),
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "chanrobles",
      records: [],
      warnings,
    };
  }
}
