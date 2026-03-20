import type { LawCategory, LawRecord } from "../../types/law";

import {
  absoluteUrl,
  enrichRecordsWithArticleText,
  fetchDom,
  mapDate,
  normalizeWhitespace,
  nowIso,
  safeText,
  ScrapeResult,
  toLawId,
} from "./shared";

const JURISPRUDENCE_ROOT_URL = "https://chanrobles.com/scdecisions/";

const DATE_PATTERN =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;

const YEAR_PAGE_PATH_PATTERN = /\/scdecisions\/\d{4}\.php$/i;
const MONTH_PAGE_PATH_PATTERN =
  /\/scdecisions\/jurisprudence\d{4}\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{4}\/\1\d{4}\.php$/i;

const MONTH_ORDER: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MAX_TOTAL_RECORDS_PER_RUN = toBoundedInt(process.env.CHANROBLES_MAX_RECORDS_PER_RUN, 7000, 200, 50000);
const MAX_RECORDS_PER_SECTION = toBoundedInt(process.env.CHANROBLES_MAX_RECORDS_PER_SECTION, 650, 20, 15000);
const MAX_INDEX_PAGES_PER_SECTION = toBoundedInt(process.env.CHANROBLES_MAX_INDEX_PAGES_PER_SECTION, 260, 1, 5000);
const MAX_DETAIL_LINKS_PER_INDEX_PAGE = toBoundedInt(
  process.env.CHANROBLES_MAX_DETAIL_LINKS_PER_INDEX_PAGE,
  2400,
  20,
  15000,
);
const MAX_JURISPRUDENCE_RECORDS = toBoundedInt(process.env.CHANROBLES_MAX_JURISPRUDENCE_RECORDS, 2600, 20, 30000);
const RESERVED_JURISPRUDENCE_RECORDS = toBoundedInt(
  process.env.CHANROBLES_RESERVED_JURISPRUDENCE_RECORDS,
  900,
  0,
  MAX_TOTAL_RECORDS_PER_RUN,
);
const MAX_JURISPRUDENCE_YEARS = toBoundedInt(process.env.CHANROBLES_MAX_JURISPRUDENCE_YEARS, 24, 1, 130);
const MAX_JURISPRUDENCE_MONTHS_PER_YEAR = toBoundedInt(
  process.env.CHANROBLES_MAX_JURISPRUDENCE_MONTHS_PER_YEAR,
  12,
  1,
  12,
);
const ENRICH_MAX_RECORDS = toBoundedInt(process.env.CHANROBLES_ENRICH_MAX_RECORDS, 120, 0, 1200);
const MAX_WARNINGS = 80;

interface RangeSectionTarget {
  label: string;
  entryUrls: string[];
  category: LawCategory;
  idPrefix: string;
  tags: string[];
  authorityLevel: number;
  subIndexPathPattern?: RegExp;
  detailPathPattern: RegExp;
  extractLawNumberFromPath: (pathname: string) => string | undefined;
}

interface YearLink {
  year: number;
  url: string;
}

interface MonthLink {
  year: number;
  month: number;
  label: string;
  url: string;
}

const RANGE_SECTION_TARGETS: RangeSectionTarget[] = [
  {
    label: "Republic Acts",
    entryUrls: [
      "https://chanrobles.com/republicacts/",
      "https://chanrobles.com/RepublicActsmain.html",
    ],
    category: "republic_act",
    idPrefix: "chanrobles-ra",
    tags: ["chanrobles", "statutes", "republic acts"],
    authorityLevel: 74,
    subIndexPathPattern: /\/republicacts\.\d+-\d+\.html$/i,
    detailPathPattern: /\/republicactno\.?[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /republicactno\.?([0-9]+[a-z-]*)/i);
      return token ? `Republic Act No. ${token}` : undefined;
    },
  },
  {
    label: "Presidential Decrees",
    entryUrls: [
      "https://chanrobles.com/presidentialdecrees/",
      "https://chanrobles.com/PresidentialDecreesmain.html",
    ],
    category: "executive_issuance",
    idPrefix: "chanrobles-pd",
    tags: ["chanrobles", "executive issuances", "presidential decrees"],
    authorityLevel: 74,
    subIndexPathPattern: /\/presidentialdecrees\d+-\d+\.html$/i,
    detailPathPattern: /\/presidentialdecrees\/presidentialdecreeno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /presidentialdecreeno([0-9]+[a-z-]*)/i);
      return token ? `Presidential Decree No. ${token}` : undefined;
    },
  },
  {
    label: "Batas Pambansa",
    entryUrls: ["https://chanrobles.com/MgaBatasPambansamain.html"],
    category: "republic_act",
    idPrefix: "chanrobles-bp",
    tags: ["chanrobles", "statutes", "batas pambansa"],
    authorityLevel: 73,
    subIndexPathPattern: /\/bataspambansablg\.\d+-\d+\.html$/i,
    detailPathPattern: /\/bataspambansa\/bataspambansablg[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /bataspambansablg([0-9]+[a-z-]*)/i);
      return token ? `Batas Pambansa Blg. ${token}` : undefined;
    },
  },
  {
    label: "Commonwealth Acts",
    entryUrls: ["https://chanrobles.com/CommonwealthActsmain.html"],
    category: "republic_act",
    idPrefix: "chanrobles-ca",
    tags: ["chanrobles", "statutes", "commonwealth acts"],
    authorityLevel: 73,
    subIndexPathPattern: /\/commonwealthacts\.\d+-\d+\.html$/i,
    detailPathPattern: /\/commonwealthacts\/commonwealthactno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /commonwealthactno([0-9]+[a-z-]*)/i);
      return token ? `Commonwealth Act No. ${token}` : undefined;
    },
  },
  {
    label: "Acts",
    entryUrls: ["https://chanrobles.com/Actsmain.html"],
    category: "republic_act",
    idPrefix: "chanrobles-act",
    tags: ["chanrobles", "statutes", "acts"],
    authorityLevel: 72,
    subIndexPathPattern: /\/acts\.\d+-\d+\.html$/i,
    detailPathPattern: /\/acts\/actsno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /actsno([0-9]+[a-z-]*)/i);
      return token ? `Act No. ${token}` : undefined;
    },
  },
  {
    label: "Executive Orders",
    entryUrls: ["https://chanrobles.com/executiveorders/"],
    category: "executive_issuance",
    idPrefix: "chanrobles-eo",
    tags: ["chanrobles", "executive issuances", "executive orders"],
    authorityLevel: 74,
    subIndexPathPattern: /\/executiveorders(?:\/executiveorders\d{4}|\d{4})\.html$/i,
    detailPathPattern: /\/executiveorders\/\d{4}\/executiveorderno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const decoded = decodePath(pathname);
      const matched = decoded.match(/executiveorderno([0-9]+[a-z-]*)(?:-(\d{4}))?/i);

      if (!matched) {
        return undefined;
      }

      const number = normalizeNumberToken(matched[1]);
      const year = matched[2];
      return year ? `Executive Order No. ${number}-${year}` : `Executive Order No. ${number}`;
    },
  },
  {
    label: "General Orders",
    entryUrls: ["https://chanrobles.com/generalorders/"],
    category: "executive_issuance",
    idPrefix: "chanrobles-go",
    tags: ["chanrobles", "executive issuances", "general orders"],
    authorityLevel: 74,
    detailPathPattern: /\/generalorders\/generalorderno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /generalorderno([0-9]+[a-z-]*)/i);
      return token ? `General Order No. ${token}` : undefined;
    },
  },
  {
    label: "Letter of Instructions",
    entryUrls: ["https://chanrobles.com/letterofinstructions/"],
    category: "executive_issuance",
    idPrefix: "chanrobles-loi",
    tags: ["chanrobles", "executive issuances", "letter of instructions"],
    authorityLevel: 74,
    subIndexPathPattern: /\/letterofinstructions\.\d+-\d+\.html$/i,
    detailPathPattern: /\/letterofinstructions\/letterofinstructionsno[0-9a-z-]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const token = extractTokenFromPath(pathname, /letterofinstructionsno([0-9]+[a-z-]*)/i);
      return token ? `Letter of Instructions No. ${token}` : undefined;
    },
  },
  {
    label: "Administrative Orders",
    entryUrls: ["https://chanrobles.com/administrativeorders/"],
    category: "executive_issuance",
    idPrefix: "chanrobles-ao",
    tags: ["chanrobles", "executive issuances", "administrative orders"],
    authorityLevel: 74,
    subIndexPathPattern: /\/administrativeorders\.(?:\d+-\d+|\d{4})\.html$/i,
    detailPathPattern: /\/administrativeorders\/administrativeorderno[^/]+\.(?:html?|htm)$/i,
    extractLawNumberFromPath: (pathname) => {
      const decoded = decodePath(pathname);
      const matched = decoded.match(/administrativeorderno([0-9]+(?:-[a-z])?)(?:\s+(\d{4}))?/i);

      if (!matched) {
        return undefined;
      }

      const number = normalizeNumberToken(matched[1]);
      const year = matched[2];

      return year ? `Administrative Order No. ${number} (${year})` : `Administrative Order No. ${number}`;
    },
  },
];

function toBoundedInt(input: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(input);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function pushWarning(warnings: string[], message: string) {
  if (warnings.length >= MAX_WARNINGS) {
    return;
  }

  warnings.push(message);
}

function getPathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isAllowedHttpUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return false;
  }

  return parsed.hostname.toLowerCase().includes("chanrobles.com");
}

function normalizeListingText(input: string): string {
  return normalizeWhitespace(input.replace(/\u00a0/g, " "));
}

function normalizeNumberToken(token: string): string {
  return normalizeWhitespace(token.replace(/[._]+/g, "-")).toUpperCase();
}

function extractTokenFromPath(pathname: string, pattern: RegExp): string | undefined {
  const decoded = decodePath(pathname);
  const token = decoded.match(pattern)?.[1];

  if (!token) {
    return undefined;
  }

  return normalizeNumberToken(token);
}

function extractDate(text: string): string | undefined {
  const matched = normalizeListingText(text).match(DATE_PATTERN)?.[0];
  return mapDate(matched);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimLawNumberPrefix(text: string, lawNumber?: string): string {
  if (!lawNumber) {
    return text;
  }

  const escapedLawNumber = escapeRegExp(normalizeListingText(lawNumber));
  const pattern = new RegExp(`^${escapedLawNumber}\\s*(?:-|:|\\u2013)?\\s*`, "i");

  return normalizeListingText(text.replace(pattern, ""));
}

function buildSummary(listingText: string, lawNumber: string, sectionLabel: string): string {
  const normalized = normalizeListingText(listingText);

  if (!normalized) {
    return `${lawNumber} indexed from ChanRobles ${sectionLabel}.`;
  }

  const trimmed = trimLawNumberPrefix(normalized, lawNumber);

  if (trimmed && trimmed.length >= 24) {
    return trimmed;
  }

  if (normalized.length >= 24 && normalized.toLowerCase() !== lawNumber.toLowerCase()) {
    return normalized;
  }

  return `${lawNumber} indexed from ChanRobles ${sectionLabel}.`;
}

function buildDedupeKey(record: Pick<LawRecord, "title" | "lawNumber" | "sourceUrl">): string {
  const normalizedLawNumber = normalizeListingText(record.lawNumber ?? "").toLowerCase();
  const normalizedTitle = normalizeListingText(record.title).toLowerCase();
  const normalizedUrl = normalizeListingText(record.sourceUrl).toLowerCase();

  return `${normalizedLawNumber || normalizedTitle}::${normalizedUrl}`;
}

function pushRecord(records: LawRecord[], seen: Set<string>, record: LawRecord): boolean {
  const key = buildDedupeKey(record);

  if (seen.has(key)) {
    return false;
  }

  seen.add(key);
  records.push(record);
  return true;
}

function parsePriorityValue(url: string): number {
  const pathname = getPathname(url);
  const rangeMatch = pathname.match(/(\d+)-(\d+)\.html?$/i);

  if (rangeMatch) {
    return Number(rangeMatch[1]);
  }

  const yearMatch = pathname.match(/(\d{4})\.html?$/i);

  if (yearMatch) {
    return Number(yearMatch[1]);
  }

  return -1;
}

function sortIndexPages(urls: string[], subIndexPathPattern?: RegExp): string[] {
  return urls
    .slice()
    .sort((left, right) => {
      const leftPath = getPathname(left);
      const rightPath = getPathname(right);
      const leftIsSub = subIndexPathPattern?.test(leftPath) ? 1 : 0;
      const rightIsSub = subIndexPathPattern?.test(rightPath) ? 1 : 0;

      if (leftIsSub !== rightIsSub) {
        return rightIsSub - leftIsSub;
      }

      const valueDiff = parsePriorityValue(right) - parsePriorityValue(left);

      if (valueDiff !== 0) {
        return valueDiff;
      }

      return left.localeCompare(right);
    });
}

async function collectIndexPages(target: RangeSectionTarget, warnings: string[]): Promise<string[]> {
  const discovered = new Set<string>();

  for (const entryUrl of target.entryUrls) {
    discovered.add(entryUrl);

    try {
      const $ = await fetchDom(entryUrl);

      $("a[href]").each((_, element) => {
        const href = $(element).attr("href");

        if (!href) {
          return;
        }

        const resolved = absoluteUrl(entryUrl, href);

        if (!isAllowedHttpUrl(resolved)) {
          return;
        }

        if (!target.subIndexPathPattern) {
          return;
        }

        if (target.subIndexPathPattern.test(getPathname(resolved))) {
          discovered.add(resolved);
        }
      });
    } catch (error) {
      pushWarning(
        warnings,
        `ChanRobles ${target.label} entry scrape failed (${entryUrl}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
      );
    }
  }

  return sortIndexPages(Array.from(discovered), target.subIndexPathPattern).slice(0, MAX_INDEX_PAGES_PER_SECTION);
}

function parseDetailCandidates(
  $: Awaited<ReturnType<typeof fetchDom>>,
  indexUrl: string,
  target: RangeSectionTarget,
): Array<{ detailUrl: string; listingText: string }> {
  const byUrl = new Map<string, string>();

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");

    if (!href) {
      return;
    }

    const detailUrl = absoluteUrl(indexUrl, href);

    if (!isAllowedHttpUrl(detailUrl)) {
      return;
    }

    if (!target.detailPathPattern.test(getPathname(detailUrl))) {
      return;
    }

    const listingText = normalizeListingText(safeText(anchor));
    const existing = byUrl.get(detailUrl);

    if (!existing || listingText.length > existing.length) {
      byUrl.set(detailUrl, listingText);
    }
  });

  return Array.from(byUrl.entries())
    .map(([detailUrl, listingText]) => ({ detailUrl, listingText }))
    .slice(0, MAX_DETAIL_LINKS_PER_INDEX_PAGE);
}

async function scrapeRangeSection(
  target: RangeSectionTarget,
  records: LawRecord[],
  seen: Set<string>,
  warnings: string[],
  maxRecordsForSection: number,
) {
  let added = 0;
  const indexPages = await collectIndexPages(target, warnings);

  for (const indexUrl of indexPages) {
    if (records.length >= MAX_TOTAL_RECORDS_PER_RUN || added >= maxRecordsForSection) {
      break;
    }

    try {
      const $ = await fetchDom(indexUrl);
      const candidates = parseDetailCandidates($, indexUrl, target);

      for (const candidate of candidates) {
        if (records.length >= MAX_TOTAL_RECORDS_PER_RUN || added >= maxRecordsForSection) {
          break;
        }

        const pathname = getPathname(candidate.detailUrl);
        const lawNumber = target.extractLawNumberFromPath(pathname);

        if (!lawNumber) {
          continue;
        }

        const summary = buildSummary(candidate.listingText, lawNumber, target.label);
        const enactedOn = extractDate(candidate.listingText);

        const record: LawRecord = {
          id: toLawId(target.idPrefix, `${lawNumber}-${candidate.detailUrl}`),
          title: lawNumber,
          lawNumber,
          category: target.category,
          summary,
          enactedOn,
          source: "chanrobles",
          sourceUrl: candidate.detailUrl,
          tags: [...target.tags],
          fullTextPreview: summary,
          isPrimarySource: false,
          freshness: "stale",
          lastVerifiedAt: nowIso(),
          authorityLevel: target.authorityLevel,
        };

        if (pushRecord(records, seen, record)) {
          added += 1;
        }
      }
    } catch (error) {
      pushWarning(
        warnings,
        `ChanRobles ${target.label} index scrape failed (${indexUrl}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
      );
    }
  }

  if (!added) {
    pushWarning(warnings, `No records parsed for ChanRobles ${target.label}.`);
  }
}

function parseJurisprudenceYearLinks($: Awaited<ReturnType<typeof fetchDom>>): YearLink[] {
  const currentYear = new Date().getUTCFullYear();
  const byYear = new Map<number, string>();

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const label = normalizeListingText(safeText(anchor));
    const href = anchor.attr("href");

    if (!href || !/^\d{4}$/.test(label)) {
      return;
    }

    const year = Number(label);

    if (!Number.isFinite(year) || year < 1900 || year > currentYear) {
      return;
    }

    const resolved = absoluteUrl(JURISPRUDENCE_ROOT_URL, href);

    if (!isAllowedHttpUrl(resolved)) {
      return;
    }

    if (!YEAR_PAGE_PATH_PATTERN.test(getPathname(resolved))) {
      return;
    }

    byYear.set(year, resolved);
  });

  return Array.from(byYear.entries())
    .map(([year, url]) => ({ year, url }))
    .sort((left, right) => right.year - left.year)
    .slice(0, MAX_JURISPRUDENCE_YEARS);
}

function parseJurisprudenceMonthLinks(
  $: Awaited<ReturnType<typeof fetchDom>>,
  yearUrl: string,
  year: number,
): MonthLink[] {
  const byUrl = new Map<string, MonthLink>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");

    if (!href) {
      return;
    }

    const resolved = absoluteUrl(yearUrl, href);

    if (!isAllowedHttpUrl(resolved)) {
      return;
    }

    const pathname = getPathname(resolved);
    const matched = pathname.match(MONTH_PAGE_PATH_PATTERN);

    if (!matched) {
      return;
    }

    const monthToken = matched[1].toLowerCase();
    const month = MONTH_ORDER[monthToken];

    if (!month) {
      return;
    }

    byUrl.set(resolved, {
      year,
      month,
      label: monthToken,
      url: resolved,
    });
  });

  return Array.from(byUrl.values())
    .sort((left, right) => right.month - left.month)
    .slice(0, MAX_JURISPRUDENCE_MONTHS_PER_YEAR);
}

function parseJurisprudenceCaseCandidates(
  $: Awaited<ReturnType<typeof fetchDom>>,
  monthUrl: string,
): Array<{ caseUrl: string; listingText: string }> {
  const monthPath = getPathname(monthUrl);
  const monthDirectory = monthPath.slice(0, monthPath.lastIndexOf("/") + 1);
  const byUrl = new Map<string, string>();

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");

    if (!href) {
      return;
    }

    const caseUrl = absoluteUrl(monthUrl, href);

    if (!isAllowedHttpUrl(caseUrl)) {
      return;
    }

    const pathname = getPathname(caseUrl);

    if (!pathname.startsWith(monthDirectory)) {
      return;
    }

    if (!/\.(?:php|html?)$/i.test(pathname) || pathname === monthPath) {
      return;
    }

    const listingText = normalizeListingText(safeText(anchor));
    const existing = byUrl.get(caseUrl);

    if (!existing || listingText.length > existing.length) {
      byUrl.set(caseUrl, listingText);
    }
  });

  return Array.from(byUrl.entries()).map(([caseUrl, listingText]) => ({ caseUrl, listingText }));
}

function extractDocketFromCaseText(value: string): string | undefined {
  const normalized = normalizeListingText(value);

  if (!normalized) {
    return undefined;
  }

  const matched = normalized.match(
    /\b((?:G\.R\.|A\.M\.|A\.C\.|B\.M\.|UDK|RTJ|MTJ|JIB|BAR MATTER)\s*(?:Nos?\.?\s*)?[0-9][0-9A-Z.,-]*)/i,
  )?.[1];

  return matched ? normalizeListingText(matched) : undefined;
}

function extractDocketFromCasePath(pathname: string): string | undefined {
  const decoded = decodePath(pathname);
  const grMatched = decoded.match(/\/gr_([0-9a-z-]+)_\d{4}\.(?:php|html?)$/i);

  if (grMatched) {
    return `G.R. No. ${normalizeNumberToken(grMatched[1])}`;
  }

  return undefined;
}

function extractCaseTitleFromListing(listingText: string, docket?: string): string | undefined {
  let candidate = normalizeListingText(listingText);

  if (!candidate) {
    return undefined;
  }

  if (docket) {
    const docketPattern = new RegExp(`^${escapeRegExp(docket)}\\s*`, "i");
    candidate = normalizeListingText(candidate.replace(docketPattern, ""));
  }

  const dateMatch = candidate.match(DATE_PATTERN);

  if (dateMatch?.[0]) {
    candidate = normalizeListingText(candidate.replace(dateMatch[0], ""));
  }

  candidate = candidate.replace(/^[-:|,\s]+/, "").trim();
  return candidate.length >= 4 ? candidate : undefined;
}

async function scrapeJurisprudence(
  records: LawRecord[],
  seen: Set<string>,
  warnings: string[],
  maxRecordsOverride?: number,
) {
  let added = 0;
  let yearsWithoutMonthPages = 0;
  const maxRecordsForJurisprudence = Math.min(
    maxRecordsOverride ?? MAX_JURISPRUDENCE_RECORDS,
    MAX_TOTAL_RECORDS_PER_RUN - records.length,
  );

  if (maxRecordsForJurisprudence <= 0) {
    return;
  }

  try {
    const $ = await fetchDom(JURISPRUDENCE_ROOT_URL);
    const yearLinks = parseJurisprudenceYearLinks($);

    if (!yearLinks.length) {
      pushWarning(warnings, "No ChanRobles Supreme Court year links were parsed from scdecisions.");
      return;
    }

    for (const yearLink of yearLinks) {
      if (added >= maxRecordsForJurisprudence || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        break;
      }

      try {
        const yearPage = await fetchDom(yearLink.url);
        const monthLinks = parseJurisprudenceMonthLinks(yearPage, yearLink.url, yearLink.year);

        if (!monthLinks.length) {
          yearsWithoutMonthPages += 1;
          continue;
        }

        for (const monthLink of monthLinks) {
          if (added >= maxRecordsForJurisprudence || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
            break;
          }

          try {
            const monthPage = await fetchDom(monthLink.url);
            const cases = parseJurisprudenceCaseCandidates(monthPage, monthLink.url);

            for (const entry of cases) {
              if (added >= maxRecordsForJurisprudence || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
                break;
              }

              const pathname = getPathname(entry.caseUrl);
              const docket = extractDocketFromCaseText(entry.listingText) ?? extractDocketFromCasePath(pathname);

              if (!docket) {
                continue;
              }

              const caseTitle = extractCaseTitleFromListing(entry.listingText, docket);
              const enactedOn = extractDate(entry.listingText);
              const title = caseTitle || docket;
              const summary = caseTitle
                ? `${caseTitle} (${docket}) indexed from ChanRobles Supreme Court listings.`
                : `${docket} indexed from ChanRobles Supreme Court listings.`;

              const record: LawRecord = {
                id: toLawId("chanrobles-sc", `${docket}-${entry.caseUrl}`),
                title,
                lawNumber: docket,
                category: "jurisprudence",
                summary,
                enactedOn,
                source: "chanrobles",
                sourceUrl: entry.caseUrl,
                tags: [
                  "chanrobles",
                  "jurisprudence",
                  "supreme court",
                  `year:${yearLink.year}`,
                  `month:${monthLink.label}`,
                ],
                fullTextPreview: summary,
                isPrimarySource: false,
                freshness: "stale",
                lastVerifiedAt: nowIso(),
                authorityLevel: 74,
              };

              if (pushRecord(records, seen, record)) {
                added += 1;
              }
            }
          } catch (error) {
            pushWarning(
              warnings,
              `ChanRobles jurisprudence month scrape failed (${monthLink.url}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
            );
          }
        }
      } catch (error) {
        pushWarning(
          warnings,
          `ChanRobles jurisprudence year scrape failed (${yearLink.url}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
        );
      }
    }

    if (yearsWithoutMonthPages > 0) {
      pushWarning(
        warnings,
        `ChanRobles jurisprudence had ${yearsWithoutMonthPages} year page(s) without month-level case listings.`,
      );
    }

    if (!added) {
      pushWarning(warnings, "No ChanRobles Supreme Court case entries were parsed from year/month listings.");
    }
  } catch (error) {
    pushWarning(
      warnings,
      `ChanRobles jurisprudence root scrape failed: ${error instanceof Error ? error.message : "Unknown scrape error"}`,
    );
  }
}

export async function scrapeChanrobles(): Promise<ScrapeResult> {
  const warnings: string[] = [];
  const records: LawRecord[] = [];
  const seen = new Set<string>();

  try {
    const reservedJurisprudence = Math.min(RESERVED_JURISPRUDENCE_RECORDS, MAX_TOTAL_RECORDS_PER_RUN - records.length);

    if (reservedJurisprudence > 0) {
      await scrapeJurisprudence(records, seen, warnings, reservedJurisprudence);
    }

    for (const target of RANGE_SECTION_TARGETS) {
      if (records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        break;
      }

      const remaining = MAX_TOTAL_RECORDS_PER_RUN - records.length;
      const maxForSection = Math.min(MAX_RECORDS_PER_SECTION, remaining);

      if (maxForSection <= 0) {
        break;
      }

      await scrapeRangeSection(target, records, seen, warnings, maxForSection);
    }

    if (!records.length) {
      pushWarning(warnings, "No records parsed from ChanRobles section indexes.");
    }

    if (records.length && ENRICH_MAX_RECORDS > 0) {
      await enrichRecordsWithArticleText(records, {
        warnings,
        sourceLabel: "chanrobles",
        maxRecords: Math.min(ENRICH_MAX_RECORDS, records.length),
        minTextLength: 220,
        maxTextLength: 24000,
      });
    }

    return {
      source: "chanrobles",
      records,
      warnings,
    };
  } catch (error) {
    pushWarning(warnings, error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "chanrobles",
      records,
      warnings,
    };
  }
}
