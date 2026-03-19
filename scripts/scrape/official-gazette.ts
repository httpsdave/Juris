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

const SECTION_URL = "https://www.officialgazette.gov.ph/section/republic-acts/";
const FALLBACK_URL = "https://www.officialgazette.gov.ph/";
const SECTION_FEED_URL = "https://www.officialgazette.gov.ph/section/republic-acts/feed/";
const GENERAL_FEED_URL = "https://www.officialgazette.gov.ph/feed/";
const OG_PDF_RECORD_LIMIT = 70;
const OG_PDF_MIN_TEXT_LENGTH = 260;
const OG_PDF_MAX_TEXT_LENGTH = 30000;
const PDF_FETCH_MAX_BYTES = 24 * 1024 * 1024;
const MAX_INLINE_WARNINGS = 14;
const PDF_QUERY_KEYS = ["url", "file", "src", "document", "doc", "download", "attachment"] as const;

interface PdfParseLegacyResult {
  text?: string;
  numpages?: number;
}

type PdfParseLegacyFn = (data: Buffer) => Promise<PdfParseLegacyResult>;

interface PdfParseV2Instance {
  getText: () => Promise<{ text?: string } | string>;
  destroy?: () => Promise<void>;
}

type PdfParseV2Ctor = new (options: { data: Buffer }) => PdfParseV2Instance;

type PdfTextExtractor = (data: Buffer) => Promise<{ text: string; pageCount?: number } | undefined>;

let cachedPdfTextExtractor: PdfTextExtractor | null | undefined;

function pushLimitedWarning(warnings: string[], message: string) {
  if (warnings.length >= MAX_INLINE_WARNINGS) {
    return;
  }

  warnings.push(message);
}

function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const chunk = text.slice(0, maxLength);
  const lastSpace = chunk.lastIndexOf(" ");

  if (lastSpace < Math.floor(maxLength * 0.6)) {
    return `${chunk.trim()}...`;
  }

  return `${chunk.slice(0, lastSpace).trim()}...`;
}

function summaryLooksGeneric(summary: string): boolean {
  const normalized = normalizeWhitespace(summary.toLowerCase());

  if (!normalized || normalized.length < 80) {
    return true;
  }

  return /^(discovered from|primary publication listing|about official gazette)/i.test(normalized);
}

function summarizeText(text: string, maxLength = 320): string {
  const cleaned = normalizeWhitespace(text);

  if (!cleaned) {
    return "";
  }

  const sentenceMatch = cleaned.match(/.{80,320}?[.!?](\s|$)/);

  if (sentenceMatch?.[0]) {
    return truncateAtWord(sentenceMatch[0].trim(), maxLength);
  }

  return truncateAtWord(cleaned, maxLength);
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

async function fetchPdfBinary(pdfUrl: string): Promise<Buffer> {
  const response = await fetch(pdfUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const announcedContentLength = Number(response.headers.get("content-length") ?? "0");

  if (Number.isFinite(announcedContentLength) && announcedContentLength > PDF_FETCH_MAX_BYTES) {
    throw new Error(`PDF exceeds max size limit (${announcedContentLength} bytes).`);
  }

  const binary = Buffer.from(await response.arrayBuffer());

  if (!binary.length) {
    throw new Error("PDF response body was empty.");
  }

  if (binary.length > PDF_FETCH_MAX_BYTES) {
    throw new Error(`PDF exceeds max size limit (${binary.length} bytes).`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const hasPdfMagicHeader = binary.subarray(0, 4).toString("utf8") === "%PDF";

  if (!hasPdfMagicHeader && !contentType.includes("application/pdf")) {
    throw new Error(`Expected PDF content but got ${contentType || "unknown content type"}.`);
  }

  return binary;
}

async function getPdfTextExtractor(warnings: string[]): Promise<PdfTextExtractor | null> {
  if (cachedPdfTextExtractor !== undefined) {
    return cachedPdfTextExtractor;
  }

  try {
    const pdfParseModule = await import("pdf-parse");
    const defaultExport = (pdfParseModule as { default?: unknown }).default;

    if (typeof defaultExport === "function") {
      const parseLegacy = defaultExport as PdfParseLegacyFn;

      cachedPdfTextExtractor = async (data: Buffer) => {
        const parsed = await parseLegacy(data);
        const text = normalizePdfText(parsed?.text ?? "");

        if (!text) {
          return undefined;
        }

        return {
          text,
          pageCount: parsed?.numpages,
        };
      };

      return cachedPdfTextExtractor;
    }

    const parserCtor = (pdfParseModule as { PDFParse?: unknown }).PDFParse;

    if (typeof parserCtor === "function") {
      const PdfParser = parserCtor as PdfParseV2Ctor;

      cachedPdfTextExtractor = async (data: Buffer) => {
        const parser = new PdfParser({ data });

        try {
          const parsed = await parser.getText();
          const text = normalizePdfText(typeof parsed === "string" ? parsed : parsed?.text ?? "");

          if (!text) {
            return undefined;
          }

          return { text };
        } finally {
          if (parser.destroy) {
            await parser.destroy().catch(() => undefined);
          }
        }
      };

      return cachedPdfTextExtractor;
    }

    cachedPdfTextExtractor = null;
    pushLimitedWarning(warnings, "Official Gazette PDF extraction is unavailable: unsupported pdf-parse export shape.");
    return null;
  } catch (error) {
    cachedPdfTextExtractor = null;
    pushLimitedWarning(
      warnings,
      `Official Gazette PDF extraction is unavailable: ${error instanceof Error ? error.message : "Unknown parser load error"}`,
    );
    return null;
  }
}

async function extractTextFromPdf(pdfUrl: string, warnings: string[]): Promise<string | undefined> {
  const extractor = await getPdfTextExtractor(warnings);

  if (!extractor) {
    return undefined;
  }

  const binary = await fetchPdfBinary(pdfUrl);
  const parsed = await extractor(binary);

  return parsed?.text;
}

async function enrichOfficialGazetteWithPdf(records: LawRecord[], warnings: string[]) {
  let pdfLinkedCount = 0;
  let pdfTextCount = 0;

  for (const record of records.slice(0, OG_PDF_RECORD_LIMIT)) {
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

    try {
      const pdfText = await extractTextFromPdf(sourcePdfUrl, warnings);

      if (!pdfText || pdfText.length < OG_PDF_MIN_TEXT_LENGTH) {
        continue;
      }

      const fullText = truncateAtWord(pdfText, OG_PDF_MAX_TEXT_LENGTH);
      record.fullText = fullText;
      record.fullTextPreview = truncateAtWord(fullText, 600);

      if (summaryLooksGeneric(record.summary)) {
        const summary = summarizeText(fullText, 320);

        if (summary) {
          record.summary = summary;
        }
      }

      if (!record.tags.includes("pdf text")) {
        record.tags = [...record.tags, "pdf text"];
      }

      pdfTextCount += 1;
    } catch (error) {
      pushLimitedWarning(
        warnings,
        `Official Gazette PDF extraction failed for ${record.title}: ${error instanceof Error ? error.message : "Unknown parse error"}`,
      );
    }
  }

  if (!pdfLinkedCount) {
    warnings.push("Official Gazette PDF discovery found no embedded source PDFs in sampled records.");
  } else if (!pdfTextCount) {
    warnings.push(
      "Official Gazette PDF links were detected, but text extraction returned no readable text; links are still stored for viewer mode.",
    );
  }
}

function parseLawNumber(title: string): string | undefined {
  const matched = title.match(/Republic Act\s+No\.?\s*\d+/i);
  return matched?.[0];
}

export async function scrapeOfficialGazette(): Promise<ScrapeResult> {
  const warnings: string[] = [];
  const targets = [SECTION_URL, FALLBACK_URL];

  const seen = new Set<string>();
  const records: LawRecord[] = [];

  for (const target of targets) {
    try {
      const $ = await fetchDom(target);
      const linkSelectors = ["article h3 a", "article h2 a", "h3.entry-title a", "main a", "a"];

      for (const selector of linkSelectors) {
        $(selector).each((_, element) => {
          const anchor = $(element);
          const title = safeText(anchor);
          const href = absoluteUrl(target, anchor.attr("href"));

          if (!title || !href.includes("officialgazette.gov.ph")) {
            return;
          }

          if (!/republic act|implementing|executive order|proclamation/i.test(title)) {
            return;
          }

          const key = `${title.toLowerCase()}::${href}`;

          if (seen.has(key)) {
            return;
          }

          seen.add(key);

          const article = anchor.closest("article");
          const rawDate =
            safeText(article.find("time").first()) || safeText(article.find(".entry-date").first());
          const lawNumber = parseLawNumber(title);

          records.push({
            id: toLawId("og", lawNumber ?? title),
            title,
            lawNumber,
            category: /republic act/i.test(title) ? "republic_act" : "executive_issuance",
            summary: `Discovered from Official Gazette listing: ${title}`,
            enactedOn: mapDate(rawDate),
            source: "official_gazette",
            sourceUrl: href,
            tags: ["official gazette", "philippines", "laws"],
            fullTextPreview: "Primary publication listing from Official Gazette.",
            isPrimarySource: true,
            freshness: "fresh",
            lastVerifiedAt: nowIso(),
            authorityLevel: 98,
          });
        });

        if (records.length > 0) {
          break;
        }
      }
    } catch (error) {
      warnings.push(`${target}: ${error instanceof Error ? error.message : "Unknown scrape error"}`);
    }
  }

  const feedTargets = [SECTION_FEED_URL, GENERAL_FEED_URL];

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

        records.push({
          id: toLawId("og", lawNumber ?? title),
          title,
          lawNumber,
          category: /republic act/i.test(title) ? "republic_act" : "executive_issuance",
          summary: `Discovered from Official Gazette RSS feed: ${title}`,
          enactedOn: mapDate(published),
          source: "official_gazette",
          sourceUrl: recordSourceUrl,
          sourcePdfUrl,
          tags: sourcePdfUrl
            ? ["official gazette", "rss", "laws and issuances", "source pdf"]
            : ["official gazette", "rss", "laws and issuances"],
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

  return {
    source: "official_gazette",
    records: records.slice(0, 120),
    warnings,
  };
}