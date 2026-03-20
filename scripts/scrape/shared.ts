import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type { LawRecord, LawSourceId } from "../../types/law";

export interface ScrapeResult {
  source: LawSourceId;
  records: LawRecord[];
  warnings: string[];
}

interface EnrichRecordsOptions {
  warnings?: string[];
  sourceLabel?: string;
  maxRecords?: number;
  minTextLength?: number;
  maxTextLength?: number;
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeDocumentWhitespace(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toLawId(prefix: string, value: string): string {
  return `${prefix}-${value}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.text();
}

export async function fetchDom(url: string) {
  const html = await fetchHtml(url);
  return cheerio.load(html);
}

export function mapDate(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  const parsed = new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

export function absoluteUrl(base: string, href?: string | null): string {
  if (!href) {
    return base;
  }

  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

export function safeText<T extends AnyNode>(node: cheerio.Cheerio<T>): string {
  return normalizeWhitespace(node.text() ?? "");
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
  if (!summary || summary.length < 60) {
    return true;
  }

  return /^(discovered from|entry indexed|topic index entry|lawphil index entry|primary publication listing|chanrobles index link|legislative document from)/i.test(
    summary,
  );
}

function summarizeText(text: string, maxLength = 300): string {
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

function htmlToStructuredText(html: string): string {
  const withLineBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*(td|th)[^>]*>/gi, " ")
    .replace(/<\/\s*(p|div|section|article|li|ul|ol|table|thead|tbody|tr|h[1-6]|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = cheerio.load(`<body>${withLineBreaks}</body>`)("body").text();

  return normalizeDocumentWhitespace(decoded);
}

function nodeToStructuredText<T extends AnyNode>(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<T>,
): string {
  const html = $.html(node);

  if (!html) {
    return "";
  }

  return htmlToStructuredText(html);
}

function getPreferredSelectors(sourceUrl: string): string[] {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();

    if (hostname.includes("elibrary.judiciary.gov.ph")) {
      return ["#left .single_content", ".single_content", "#left"];
    }

    if (hostname.includes("officialgazette.gov.ph")) {
      return ["article .entry-content", "article .post-content", ".entry-content", ".post-content", "article"];
    }

    if (hostname.includes("chanrobles.com")) {
      return [
        ".mainContent .topcontent",
        ".mainContent .content",
        ".mainContent",
        "div[align='justify']",
        "td[align='justify']",
      ];
    }
  } catch {
    return [];
  }

  return [];
}

function trimLeadingBoilerplate(text: string): string {
  const leadingNoise =
    /(toggle posts|click the image to search|view printer friendly version|libraryservices\.sc@judiciary\.gov\.ph|foreign supreme courts|about official gazette|feedback form|privacy policy|frequently asked questions|government links|managed by ict division|chanrobles virtual law library|supreme court decisions|search for www\.chanrobles\.com|please click here for the latest|home\s*>\s*chanrobles)/i;

  const legalStart =
    /(\[\s*(republic act no\.?|proclamation no\.?|executive order no\.?|memorandum circular no\.?|irr of republic act no\.?)|republic act no\.?|proclamation no\.?|executive order no\.?|memorandum circular no\.?|presidential decree no\.?|batas pambansa blg\.?|commonwealth act no\.?|letter of instructions no\.?|administrative order no\.?|general order no\.?|act no\.?|an act\b|be it enacted|section\s+1\.?|sec\.\s*1\.?|(first|second|third)\s+division|en\s+banc|(?:g\.r\.|a\.m\.|a\.c\.|b\.m\.|bar matter)\s*(?:nos?\.?)?\s*\d)/i;

  const earlyWindow = text.slice(0, 2600);

  if (!leadingNoise.test(earlyWindow)) {
    return text;
  }

  const legalStartIndex = text.search(legalStart);

  if (legalStartIndex > 80 && legalStartIndex < 5200) {
    return text.slice(legalStartIndex);
  }

  return text;
}

function trimTrailingBoilerplate(text: string): string {
  const trailingMarkers = [
    /all content is in the public domain unless otherwise stated/i,
    /feedback form/i,
    /privacy policy/i,
    /frequently asked questions/i,
    /contact numbers\/?trunk lines/i,
    /about govph/i,
    /government links/i,
    /managed by ict division/i,
    /this website was designed and developed/i,
  ];

  let cutIndex = -1;

  for (const marker of trailingMarkers) {
    const markerIndex = text.search(marker);

    if (markerIndex < 0 || markerIndex < Math.floor(text.length * 0.5)) {
      continue;
    }

    if (cutIndex < 0 || markerIndex < cutIndex) {
      cutIndex = markerIndex;
    }
  }

  if (cutIndex < 0) {
    return text;
  }

  return text.slice(0, cutIndex);
}

function trimChanroblesLead(text: string): string {
  const startPattern =
    /(?:^|\n)\s*((?:first|second|third)\s+division|en\s+banc|(?:g\.r\.|a\.m\.|a\.c\.|b\.m\.|bar matter)\s*(?:nos?\.?)?\s*\d|republic act no\.?\s*\d|presidential decree no\.?\s*\d|executive order no\.?\s*\d|batas pambansa blg\.?\s*\d|commonwealth act no\.?\s*\d|letter of instructions no\.?\s*\d|administrative order no\.?\s*\d|general order no\.?\s*\d|act no\.?\s*\d)/i;

  const matched = text.match(startPattern);

  if (!matched || matched.index === undefined) {
    return text;
  }

  if (matched.index === 0 || matched.index > 5200) {
    return text;
  }

  return text.slice(matched.index).trim();
}

function cleanupExtractedText(text: string): string {
  const cleaned = text
    .replace(/\bToggle posts\b/gi, "")
    .replace(/\bA\s+A\+\s+A\+\+\b/gi, "")
    .replace(/\bCLICK THE IMAGE TO SEARCH\b/gi, "")
    .replace(/\bView printer friendly version\b/gi, "")
    .replace(/\bReader mode:\s*Captured Source Text\b/gi, "")
    .replace(/\bchanroblesvirtualawlibrary\b/gi, "")
    .replace(/\bchanrobles\s+virtual\s+law\s+library\b/gi, "")
    .replace(/\bsearch\s+for\s+www\.chanrobles\.com\b/gi, "")
    .replace(/\bplease\s+click\s+here\s+for\s+the\s+latest[^\n]{0,120}\b/gi, "")
    .replace(/\bhome\s*>\s*chanrobles\s+virtual\s+law\s+library[^\n]*\b/gi, "")
    .replace(/(^|\n)\s*-->\s*(?=\n|$)/g, "$1")
    .replace(/(^|\n)\s*>+\s*(?=\n|$)/g, "$1");

  const normalized = normalizeDocumentWhitespace(cleaned);
  const withoutLeadingBoilerplate = trimLeadingBoilerplate(normalized);
  const withoutTrailingBoilerplate = trimTrailingBoilerplate(withoutLeadingBoilerplate);
  const chanroblesTrimmedLead = trimChanroblesLead(withoutTrailingBoilerplate);

  return normalizeDocumentWhitespace(chanroblesTrimmedLead);
}

function scoreCandidateText(text: string): number {
  if (!text) {
    return Number.NEGATIVE_INFINITY;
  }

  const noiseMatches =
    text.match(
      /(toggle posts|click the image to search|libraryservices\.sc@judiciary\.gov\.ph|about official gazette|feedback form|privacy policy|frequently asked questions|government links|chanrobles virtual law library|search for www\.chanrobles\.com|please click here for the latest)/gi,
    )?.length ?? 0;

  return text.length - noiseMatches * 180;
}

function extractReadableText($: cheerio.CheerioAPI, sourceUrl: string): string {
  $(
    [
      "script",
      "style",
      "noscript",
      "svg",
      "nav",
      "header",
      "footer",
      "form",
      "iframe",
      "aside",
      ".share",
      ".social",
      ".menu",
      ".breadcrumbs",
      ".related",
      ".related-posts",
      ".sidebar",
      ".comments",
      "#comments",
      "#toggle-all",
      ".widget",
      "#appendix",
      "#right",
      ".site-header",
      ".site-footer",
    ].join(","),
  ).remove();

  const contentSelectors = [
    ...getPreferredSelectors(sourceUrl),
    "article",
    "main",
    ".entry-content",
    ".post-content",
    ".single-content",
    ".content",
    "#content",
    ".article-content",
    ".single-post",
    ".site-content",
    ".single_content",
    "#left",
  ];

  let bestText = "";
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const selector of contentSelectors) {
    $(selector).each((_, element) => {
      const candidate = cleanupExtractedText(nodeToStructuredText($, $(element)));
      const score = scoreCandidateText(candidate);

      if (score > bestScore) {
        bestText = candidate;
        bestScore = score;
      }
    });
  }

  if (bestText.length < 240) {
    const body = cleanupExtractedText(nodeToStructuredText($, $("body").first()));
    const bodyScore = scoreCandidateText(body);

    if (bodyScore > bestScore) {
      bestText = body;
    }
  }

  return bestText;
}

async function fetchReadableText(url: string): Promise<string | undefined> {
  try {
    const $ = await fetchDom(url);
    const text = extractReadableText($, url);

    if (text.length < 120) {
      return undefined;
    }

    return text;
  } catch {
    return undefined;
  }
}

export async function enrichRecordsWithArticleText(
  records: LawRecord[],
  options: EnrichRecordsOptions = {},
): Promise<LawRecord[]> {
  const maxRecords = Math.max(0, options.maxRecords ?? records.length);
  const minTextLength = Math.max(100, options.minTextLength ?? 220);
  const maxTextLength = Math.max(1200, options.maxTextLength ?? 24000);

  let enrichedCount = 0;

  for (const record of records) {
    if (enrichedCount >= maxRecords) {
      break;
    }

    if (!/^https?:\/\//i.test(record.sourceUrl)) {
      continue;
    }

    const text = await fetchReadableText(record.sourceUrl);

    if (!text || text.length < minTextLength) {
      continue;
    }

    const fullText = truncateAtWord(text, maxTextLength);
    record.fullText = fullText;
    record.fullTextPreview = truncateAtWord(fullText, 600);

    if (summaryLooksGeneric(record.summary)) {
      const summary = summarizeText(fullText, 320);

      if (summary) {
        record.summary = summary;
      }
    }

    if (!record.tags.includes("full text")) {
      record.tags = [...record.tags, "full text"];
    }

    enrichedCount += 1;
  }

  if (options.warnings && !enrichedCount) {
    const label = options.sourceLabel ?? "source";
    options.warnings.push(`No detail page text extracted for ${label}; keeping listing-level metadata.`);
  }

  return records;
}
