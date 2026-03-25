import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type { LawRecord } from "../../types/law";

import {
  absoluteUrl,
  enrichRecordsWithArticleText,
  fetchHtml,
  fetchDom,
  mapDate,
  nowIso,
  normalizeWhitespace,
  safeText,
  ScrapeResult,
  toLawId,
} from "./shared";
import { loadScrapeCheckpoint, patchScrapeCheckpoint } from "./checkpoint";

const FALLBACK_URL = "https://www.officialgazette.gov.ph/";
const GENERAL_FEED_URL = "https://www.officialgazette.gov.ph/feed/";
const OG_MAX_PAGES_PER_SECTION = Math.max(1, Number(process.env.OG_MAX_PAGES_PER_SECTION ?? "2500"));
const OG_MAX_PAGES_PER_RUN = Math.max(1, Number(process.env.OG_MAX_PAGES_PER_RUN ?? "120"));
const OG_EMPTY_PAGE_STREAK_LIMIT = Math.max(1, Number(process.env.OG_EMPTY_PAGE_STREAK_LIMIT ?? "2"));
const OG_MAX_TOTAL_RECORDS = Math.max(0, Number(process.env.OG_MAX_TOTAL_RECORDS ?? "0"));
const OG_REQUEST_DELAY_MS = Math.max(0, Number(process.env.OG_REQUEST_DELAY_MS ?? "250"));
const OG_429_MAX_RETRIES = Math.max(0, Number(process.env.OG_429_MAX_RETRIES ?? "6"));
const OG_429_INITIAL_BACKOFF_MS = Math.max(100, Number(process.env.OG_429_INITIAL_BACKOFF_MS ?? "1200"));
const OG_429_MAX_BACKOFF_MS = Math.max(1000, Number(process.env.OG_429_MAX_BACKOFF_MS ?? "15000"));
const OG_429_SECTION_COOLDOWN_MINUTES = Math.max(5, Number(process.env.OG_429_SECTION_COOLDOWN_MINUTES ?? "120"));
const MAX_INLINE_WARNINGS = 14;
const PDF_QUERY_KEYS = ["url", "file", "src", "document", "doc", "download", "attachment"] as const;

interface OfficialGazetteSection {
  label: string;
  key: string;
  sectionUrl: string;
  feedUrl: string;
  category: LawRecord["category"];
  defaultTags: string[];
}

const OG_SECTIONS: OfficialGazetteSection[] = [
  {
    label: "republic acts",
    key: "republic_acts",
    sectionUrl: "https://www.officialgazette.gov.ph/section/republic-acts/",
    feedUrl: "https://www.officialgazette.gov.ph/section/republic-acts/feed/",
    category: "republic_act",
    defaultTags: ["official gazette", "philippines", "republic act"],
  },
  {
    label: "executive orders",
    key: "executive_orders",
    sectionUrl: "https://www.officialgazette.gov.ph/section/executive-orders/",
    feedUrl: "https://www.officialgazette.gov.ph/section/executive-orders/feed/",
    category: "executive_issuance",
    defaultTags: ["official gazette", "philippines", "executive order"],
  },
  {
    label: "proclamations",
    key: "proclamations",
    sectionUrl: "https://www.officialgazette.gov.ph/section/proclamations/",
    feedUrl: "https://www.officialgazette.gov.ph/section/proclamations/feed/",
    category: "executive_issuance",
    defaultTags: ["official gazette", "philippines", "proclamation"],
  },
  {
    label: "administrative orders",
    key: "administrative_orders",
    sectionUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/administrative-orders/",
    feedUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/administrative-orders/feed/",
    category: "executive_issuance",
    defaultTags: ["official gazette", "philippines", "administrative order"],
  },
  {
    label: "memorandum circulars",
    key: "memorandum_circulars",
    sectionUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/memorandum-circulars/",
    feedUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/memorandum-circulars/feed/",
    category: "executive_issuance",
    defaultTags: ["official gazette", "philippines", "memorandum circular"],
  },
  {
    label: "memorandum orders",
    key: "memorandum_orders",
    sectionUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/memorandum-orders/",
    feedUrl: "https://www.officialgazette.gov.ph/section/laws/executive-issuances/memorandum-orders/feed/",
    category: "executive_issuance",
    defaultTags: ["official gazette", "philippines", "memorandum order"],
  },
];

function pushLimitedWarning(warnings: string[], message: string) {
  if (warnings.length >= MAX_INLINE_WARNINGS) {
    return;
  }

  warnings.push(message);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function resolveToDirectPdfUrl(baseUrl: string, rawUrl: string): string | undefined {
  let currentUrl = absoluteUrl(baseUrl, rawUrl);

  for (let depth = 0; depth < 4; depth += 1) {
    let parsed: URL;

    try {
      parsed = new URL(currentUrl);
    } catch {
      return undefined;
    }

    if (!parsed.protocol.startsWith("http")) {
      return undefined;
    }

    const serialized = parsed.toString();

    if (/\.pdf(?:$|[?#])/i.test(serialized)) {
      return serialized;
    }

    let nestedCandidate: string | undefined;

    for (const key of PDF_QUERY_KEYS) {
      const value = parsed.searchParams.get(key);

      if (!value) {
        continue;
      }

      const decodedValue = safeDecodeURIComponent(value);

      if (/\.pdf(?:$|[?#])/i.test(decodedValue)) {
        nestedCandidate = decodedValue;
        break;
      }

      const inlineMatch = decodedValue.match(/https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/i)?.[0];

      if (inlineMatch) {
        nestedCandidate = inlineMatch;
        break;
      }
    }

    if (!nestedCandidate) {
      const decodedCurrent = safeDecodeURIComponent(serialized);
      nestedCandidate = decodedCurrent.match(/https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/i)?.[0];
    }

    if (!nestedCandidate) {
      return undefined;
    }

    currentUrl = absoluteUrl(baseUrl, nestedCandidate);
  }

  return undefined;
}

function collectPdfCandidates($: cheerio.CheerioAPI, html: string, sourceUrl: string): string[] {
  const discovered = new Set<string>();

  const nodesToInspect: Array<{ selector: string; attribute: "href" | "src" | "data" }> = [
    { selector: "a[href]", attribute: "href" },
    { selector: "iframe[src]", attribute: "src" },
    { selector: "embed[src]", attribute: "src" },
    { selector: "object[data]", attribute: "data" },
    { selector: "source[src]", attribute: "src" },
  ];

  for (const node of nodesToInspect) {
    $(node.selector).each((_, element) => {
      const value = $(element).attr(node.attribute);

      if (!value) {
        return;
      }

      const resolved = resolveToDirectPdfUrl(sourceUrl, value);

      if (resolved) {
        discovered.add(resolved);
      }
    });
  }

  const absoluteMatches = html.match(/https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/gi) ?? [];

  for (const match of absoluteMatches) {
    const resolved = resolveToDirectPdfUrl(sourceUrl, match);

    if (resolved) {
      discovered.add(resolved);
    }
  }

  const relativeMatches = html.match(/(?:\/|\.\/|\.\.\/)[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/gi) ?? [];

  for (const match of relativeMatches) {
    const resolved = resolveToDirectPdfUrl(sourceUrl, match);

    if (resolved) {
      discovered.add(resolved);
    }
  }

  return Array.from(discovered);
}

function scorePdfUrl(url: string): number {
  const normalized = url.toLowerCase();
  let score = 0;

  if (normalized.includes("officialgazette.gov.ph")) {
    score += 8;
  }

  if (normalized.includes("/wp-content/uploads/")) {
    score += 10;
  }

  if (normalized.includes("/downloads/")) {
    score += 5;
  }

  if (normalized.includes("attachment") || normalized.includes("download")) {
    score += 2;
  }

  if (normalized.includes("viewer") || normalized.includes("gview")) {
    score -= 6;
  }

  return score;
}

function pickBestPdfUrl(candidates: string[]): string | undefined {
  if (!candidates.length) {
    return undefined;
  }

  return candidates
    .slice()
    .sort((left, right) => scorePdfUrl(right) - scorePdfUrl(left) || left.length - right.length)[0];
}

function extractFeedMarkup(node: cheerio.Cheerio<AnyNode>): string {
  const descriptionNode = node.find("description").first();
  const encodedNode = node.find("content\\:encoded").first();

  return [
    descriptionNode.html(),
    descriptionNode.text(),
    encodedNode.html(),
    encodedNode.text(),
  ]
    .map((value) => String(value ?? ""))
    .filter((value) => normalizeWhitespace(value).length > 0)
    .join("\n");
}

function extractPdfFromFeedMarkup(feedMarkup: string, articleUrl: string): string | undefined {
  const decodedMarkup = safeDecodeURIComponent(feedMarkup);
  const $ = cheerio.load(`<section>${decodedMarkup}</section>`);
  const candidates = collectPdfCandidates($, decodedMarkup, articleUrl);
  return pickBestPdfUrl(candidates);
}

async function enrichOfficialGazetteWithPdf(records: LawRecord[], warnings: string[]) {
  let pdfLinkedCount = 0;

  for (const record of records) {
    if (!/^https?:\/\//i.test(record.sourceUrl)) {
      continue;
    }

    let sourcePdfUrl = record.sourcePdfUrl;

    if (!sourcePdfUrl) {
      try {
        const articleHtml = await fetchHtml(record.sourceUrl);
        const $ = cheerio.load(articleHtml);
        const pdfCandidates = collectPdfCandidates($, articleHtml, record.sourceUrl);
        sourcePdfUrl = pickBestPdfUrl(pdfCandidates);
      } catch (error) {
        pushLimitedWarning(
          warnings,
          `Official Gazette article parse failed (${record.sourceUrl}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
        );
        continue;
      }
    }

    if (!sourcePdfUrl) {
      continue;
    }

    record.sourcePdfUrl = sourcePdfUrl;
    pdfLinkedCount += 1;

    if (!record.tags.includes("source pdf")) {
      record.tags = [...record.tags, "source pdf"];
    }
  }

  if (!pdfLinkedCount) {
    warnings.push("Official Gazette PDF discovery found no embedded source PDFs in discovered records.");
  }
}

function buildPaginatedSectionUrl(sectionUrl: string, pageNumber: number): string {
  if (pageNumber <= 1) {
    return sectionUrl;
  }

  const normalized = sectionUrl.endsWith("/") ? sectionUrl : `${sectionUrl}/`;
  return `${normalized}page/${pageNumber}/`;
}

function parseLawNumber(title: string): string | undefined {
  const matched = title.match(
    /(Republic Act\s+No\.?\s*\d+|Executive Order\s+No\.?\s*\d+|Proclamation\s+No\.?\s*\d+|Administrative Order\s+No\.?\s*\d+|Memorandum (?:Circular|Order)\s+No\.?\s*\d+)/i,
  );

  return matched?.[0]?.replace(/\s+/g, " ").trim();
}

function inferCategory(title: string, fallback: LawRecord["category"]): LawRecord["category"] {
  return /republic\s+act/i.test(title) ? "republic_act" : fallback;
}

function toSectionRecord(
  title: string,
  href: string,
  rawDate: string,
  section: OfficialGazetteSection,
): LawRecord {
  const lawNumber = parseLawNumber(title);

  return {
    id: toLawId("og", lawNumber ?? title),
    title,
    lawNumber,
    category: inferCategory(title, section.category),
    summary: `Discovered from Official Gazette ${section.label} listing: ${title}`,
    enactedOn: mapDate(rawDate),
    source: "official_gazette",
    sourceUrl: href,
    tags: Array.from(new Set([...section.defaultTags, "laws and issuances"])),
    fullTextPreview: "Primary publication listing from Official Gazette.",
    isPrimarySource: true,
    freshness: "fresh",
    lastVerifiedAt: nowIso(),
    authorityLevel: 98,
  };
}

function ingestListingPage(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  section: OfficialGazetteSection,
  seen: Set<string>,
  records: LawRecord[],
): number {
  const before = records.length;

  $("article").each((_, element) => {
    const article = $(element);
    const anchorSelectors = ["h2.entry-title a", "h3.entry-title a", "a[rel='bookmark']", "a"];
    let anchor = article.find(anchorSelectors[0]).first();

    for (const selector of anchorSelectors) {
      const candidate = article.find(selector).first();

      if (candidate.length) {
        anchor = candidate;
        break;
      }
    }

    const title = safeText(anchor);
    const href = absoluteUrl(pageUrl, anchor.attr("href"));

    if (!title || !href.includes("officialgazette.gov.ph")) {
      return;
    }

    if (/\/section\//i.test(href) || /\/tag\//i.test(href) || /\/category\//i.test(href)) {
      return;
    }

    const key = `${title.toLowerCase()}::${href}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const rawDate =
      safeText(article.find("time").first()) ||
      article.find("time").first().attr("datetime") ||
      safeText(article.find(".entry-date").first());

    records.push(toSectionRecord(title, href, rawDate, section));
  });

  return records.length - before;
}

async function scrapeSectionListings(
  section: OfficialGazetteSection,
  seen: Set<string>,
  records: LawRecord[],
  warnings: string[],
  startPage: number,
) {
  let emptyStreak = 0;
  let currentBackoffMs = OG_429_INITIAL_BACKOFF_MS;
  let pageNumber = startPage;
  let processedPages = 0;

  while (pageNumber <= OG_MAX_PAGES_PER_SECTION && processedPages < OG_MAX_PAGES_PER_RUN) {
    if (OG_MAX_TOTAL_RECORDS > 0 && records.length >= OG_MAX_TOTAL_RECORDS) {
      return { nextPage: pageNumber, stopReason: "max_total_records" as const };
    }

    const pageUrl = buildPaginatedSectionUrl(section.sectionUrl, pageNumber);
    let loadedPage = false;
    let hitRateLimit = false;

    for (let attempt = 0; attempt <= OG_429_MAX_RETRIES; attempt += 1) {
      try {
        const $ = await fetchDom(pageUrl);
        const added = ingestListingPage($, pageUrl, section, seen, records);
        loadedPage = true;
        currentBackoffMs = OG_429_INITIAL_BACKOFF_MS;

        if (added === 0) {
          emptyStreak += 1;

          if (emptyStreak >= OG_EMPTY_PAGE_STREAK_LIMIT) {
            return { nextPage: 1, stopReason: "section_end" as const };
          }

          break;
        }

        emptyStreak = 0;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown scrape error";
        const isRateLimited = /429|too many requests/i.test(message);
        const isNotFound = /404|not found/i.test(message);

        if (isNotFound) {
          return { nextPage: 1, stopReason: "section_end" as const };
        }

        if (isRateLimited && attempt < OG_429_MAX_RETRIES) {
          await sleep(currentBackoffMs);
          currentBackoffMs = Math.min(
            OG_429_MAX_BACKOFF_MS,
            Math.max(OG_429_INITIAL_BACKOFF_MS, Math.floor(currentBackoffMs * 1.7)),
          );
          continue;
        }

        if (isRateLimited) {
          hitRateLimit = true;
        }

        pushLimitedWarning(warnings, `${section.label} page ${pageNumber}: ${message}`);

        if (pageNumber === 1) {
          return {
            nextPage: pageNumber,
            stopReason: hitRateLimit ? ("rate_limited" as const) : ("error" as const),
          };
        }

        emptyStreak += 1;

        if (emptyStreak >= OG_EMPTY_PAGE_STREAK_LIMIT) {
          return {
            nextPage: pageNumber,
            stopReason: hitRateLimit ? ("rate_limited" as const) : ("error" as const),
          };
        }

        break;
      }
    }

    if (!loadedPage) {
      if (hitRateLimit) {
        return { nextPage: pageNumber, stopReason: "rate_limited" as const };
      }

      pageNumber += 1;
      processedPages += 1;
      continue;
    }

    if (OG_REQUEST_DELAY_MS > 0) {
      await sleep(OG_REQUEST_DELAY_MS);
    }

    pageNumber += 1;
    processedPages += 1;
  }

  if (pageNumber > OG_MAX_PAGES_PER_SECTION) {
    return { nextPage: 1, stopReason: "section_end" as const };
  }

  return { nextPage: pageNumber, stopReason: "run_budget" as const };
}

export async function scrapeOfficialGazette(): Promise<ScrapeResult> {
  const warnings: string[] = [];
  const checkpoint = await loadScrapeCheckpoint();
  const nextCursor = { ...checkpoint.officialGazetteCursor };

  const seen = new Set<string>();
  const records: LawRecord[] = [];

  const now = Date.now();

  for (const section of OG_SECTIONS) {
    const sectionState = checkpoint.officialGazetteCursor[section.key];
    const blockedUntilValue = sectionState?.blockedUntil;
    const blockedUntilTs = blockedUntilValue ? new Date(blockedUntilValue).getTime() : 0;

    if (blockedUntilTs && Number.isFinite(blockedUntilTs) && blockedUntilTs > now) {
      continue;
    }

    const startPage = Math.max(1, sectionState?.nextPage ?? 1);
    const outcome = await scrapeSectionListings(section, seen, records, warnings, startPage);

    if (outcome.stopReason === "rate_limited") {
      const cooldownUntil = new Date(now + OG_429_SECTION_COOLDOWN_MINUTES * 60 * 1000).toISOString();
      nextCursor[section.key] = {
        nextPage: Math.max(1, outcome.nextPage),
        blockedUntil: cooldownUntil,
      };
    } else {
      nextCursor[section.key] = {
        nextPage: Math.max(1, outcome.nextPage),
      };
    }

    if (OG_MAX_TOTAL_RECORDS > 0 && records.length >= OG_MAX_TOTAL_RECORDS) {
      break;
    }
  }

  if (!records.length) {
    try {
      const $ = await fetchDom(FALLBACK_URL);
      ingestListingPage(
        $,
        FALLBACK_URL,
        {
          label: "homepage",
          key: "homepage",
          sectionUrl: FALLBACK_URL,
          feedUrl: GENERAL_FEED_URL,
          category: "executive_issuance",
          defaultTags: ["official gazette", "philippines", "fallback"],
        },
        seen,
        records,
      );
    } catch (error) {
      warnings.push(
        `${FALLBACK_URL}: ${error instanceof Error ? error.message : "Unknown scrape error"}`,
      );
    }
  }

  const feedTargets = [...OG_SECTIONS.map((section) => section.feedUrl), GENERAL_FEED_URL];

  for (const feedUrl of feedTargets) {
    try {
      const feed = await fetchHtml(feedUrl);
      const $ = cheerio.load(feed, { xmlMode: true });

      $("item").each((_, item) => {
        const node = $(item);
        const title = normalizeWhitespace(String(node.find("title").first().text() ?? ""));
        const href = normalizeWhitespace(String(node.find("link").first().text() ?? ""));
        const published = normalizeWhitespace(String(node.find("pubDate").first().text() ?? ""));
        const recordSourceUrl = absoluteUrl(feedUrl, href);
        const feedMarkup = extractFeedMarkup(node);
        const sourcePdfUrl = feedMarkup
          ? extractPdfFromFeedMarkup(feedMarkup, recordSourceUrl)
          : undefined;
        const categories = node
          .find("category")
          .toArray()
          .map((category) => normalizeWhitespace(String($(category).text() ?? "").toLowerCase()));

        const seemsLegal =
          /republic act|executive order|proclamation|memorandum|administrative order/i.test(title) ||
          categories.some((entry) => /laws|issuance|republic acts|executive issuances/.test(entry));

        if (!title || !href || !seemsLegal) {
          return;
        }

        const key = `${title.toLowerCase()}::${href}`;

        if (seen.has(key)) {
          return;
        }

        seen.add(key);

        const lawNumber = parseLawNumber(title);
        const section = OG_SECTIONS.find((entry) => feedUrl.startsWith(entry.feedUrl));
        const category = inferCategory(title, section?.category ?? "executive_issuance");
        const baseTags = section?.defaultTags ?? ["official gazette", "rss", "laws and issuances"];

        records.push({
          id: toLawId("og", lawNumber ?? title),
          title,
          lawNumber,
          category,
          summary: `Discovered from Official Gazette RSS feed: ${title}`,
          enactedOn: mapDate(published),
          source: "official_gazette",
          sourceUrl: recordSourceUrl,
          sourcePdfUrl,
          tags: sourcePdfUrl ? [...baseTags, "rss", "source pdf"] : [...baseTags, "rss"],
          fullTextPreview: "Primary publication listing from Official Gazette feed.",
          isPrimarySource: true,
          freshness: "fresh",
          lastVerifiedAt: nowIso(),
          authorityLevel: 98,
        });
      });
    } catch (error) {
      warnings.push(
        `Official Gazette RSS ingest (${feedUrl}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
      );
    }
  }

  if (!records.length) {
    warnings.push("No records parsed from Official Gazette selectors.");
  }

  if (records.length) {
    await enrichRecordsWithArticleText(records, {
      warnings,
      sourceLabel: "official gazette",
      maxRecords: 70,
      minTextLength: 280,
      maxTextLength: 30000,
    });

    await enrichOfficialGazetteWithPdf(records, warnings);
  }

  try {
    await patchScrapeCheckpoint({ officialGazetteCursor: nextCursor });
  } catch (error) {
    pushLimitedWarning(
      warnings,
      `Unable to persist official gazette checkpoint: ${error instanceof Error ? error.message : "Unknown checkpoint error"}`,
    );
  }

  return {
    source: "official_gazette",
    records,
    warnings,
  };
}
