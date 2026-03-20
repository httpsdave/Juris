import type { LawCategory, LawRecord } from "../../types/law";

import {
  absoluteUrl,
  enrichRecordsWithArticleText,
  fetchDom,
  mapDate,
  nowIso,
  normalizeWhitespace,
  safeText,
  ScrapeResult,
  toLawId,
} from "./shared";

const JURISPRUDENCE_ROOT_URL = "https://lawphil.net/judjuris/judjuris.html";

const DATE_PATTERN =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;

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

const INDEX_PATH_PATTERN = /\.html?(?:$|[?#])/i;
const YEAR_PAGE_PATH_PATTERN = /\/juri\d{4}\/juri\d{4}\.html$/i;
const MONTH_PAGE_PATH_PATTERN = /\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{4}\/\1\d{4}\.html$/i;

const MAX_TOTAL_RECORDS_PER_RUN = toBoundedInt(process.env.LAWPHIL_MAX_RECORDS_PER_RUN, 9000, 400, 30000);
const MAX_ROWS_PER_INDEX_PAGE = toBoundedInt(process.env.LAWPHIL_MAX_ROWS_PER_INDEX_PAGE, 1200, 50, 12000);
const MAX_JURISPRUDENCE_RECORDS = toBoundedInt(process.env.LAWPHIL_MAX_JURISPRUDENCE_RECORDS, 2200, 50, 12000);
const MAX_JURISPRUDENCE_YEARS = toBoundedInt(process.env.LAWPHIL_MAX_JURISPRUDENCE_YEARS, 8, 1, 40);
const MAX_JURISPRUDENCE_MONTHS_PER_YEAR = toBoundedInt(
  process.env.LAWPHIL_MAX_JURISPRUDENCE_MONTHS_PER_YEAR,
  12,
  1,
  12,
);
const ENRICH_MAX_RECORDS = toBoundedInt(process.env.LAWPHIL_ENRICH_MAX_RECORDS, 120, 0, 1200);

interface LawphilIndexTarget {
  label: string;
  url: string;
  category: LawCategory;
  idPrefix: string;
  tags: string[];
  authorityLevel: number;
}

interface ConstitutionTarget {
  title: string;
  url: string;
}

interface YearLink {
  year: number;
  url: string;
}

interface MonthLink {
  label: string;
  month: number;
  url: string;
}

interface RowLike {
  find: (selector: string) => {
    first: () => {
      attr: (name: "href" | "xref") => string | undefined;
    };
  };
}

const STATUTE_TARGETS: LawphilIndexTarget[] = [
  {
    label: "Acts",
    url: "https://lawphil.net/statutes/acts/acts.html",
    category: "republic_act",
    idPrefix: "lawphil-act",
    tags: ["lawphil", "statutes", "acts"],
    authorityLevel: 83,
  },
  {
    label: "Commonwealth Acts",
    url: "https://lawphil.net/statutes/comacts/comacts.html",
    category: "republic_act",
    idPrefix: "lawphil-ca",
    tags: ["lawphil", "statutes", "commonwealth acts"],
    authorityLevel: 83,
  },
  {
    label: "Batas Pambansa",
    url: "https://lawphil.net/statutes/bataspam/bataspam.html",
    category: "republic_act",
    idPrefix: "lawphil-bp",
    tags: ["lawphil", "statutes", "batas pambansa"],
    authorityLevel: 83,
  },
  {
    label: "Republic Acts",
    url: "https://lawphil.net/statutes/repacts/repacts.html",
    category: "republic_act",
    idPrefix: "lawphil-ra",
    tags: ["lawphil", "statutes", "republic acts"],
    authorityLevel: 84,
  },
];

const EXECUTIVE_TARGETS: LawphilIndexTarget[] = [
  {
    label: "Executive Orders",
    url: "https://lawphil.net/executive/execord/execord.html",
    category: "executive_issuance",
    idPrefix: "lawphil-eo",
    tags: ["lawphil", "executive issuances", "executive orders"],
    authorityLevel: 84,
  },
  {
    label: "Presidential Decrees",
    url: "https://lawphil.net/statutes/presdecs/legis_pd.html",
    category: "executive_issuance",
    idPrefix: "lawphil-pd",
    tags: ["lawphil", "executive issuances", "presidential decrees"],
    authorityLevel: 84,
  },
  {
    label: "Administrative Orders",
    url: "https://lawphil.net/executive/ao/ao.html",
    category: "executive_issuance",
    idPrefix: "lawphil-ao",
    tags: ["lawphil", "executive issuances", "administrative orders"],
    authorityLevel: 84,
  },
  {
    label: "Memorandum Circulars",
    url: "https://lawphil.net/executive/mc/mc.html",
    category: "executive_issuance",
    idPrefix: "lawphil-mc",
    tags: ["lawphil", "executive issuances", "memorandum circulars"],
    authorityLevel: 84,
  },
  {
    label: "Memorandum Orders",
    url: "https://lawphil.net/executive/mo/mo.html",
    category: "executive_issuance",
    idPrefix: "lawphil-mo",
    tags: ["lawphil", "executive issuances", "memorandum orders"],
    authorityLevel: 84,
  },
  {
    label: "Proclamations",
    url: "https://lawphil.net/executive/proc/proc.html",
    category: "executive_issuance",
    idPrefix: "lawphil-proc",
    tags: ["lawphil", "executive issuances", "proclamations"],
    authorityLevel: 84,
  },
  {
    label: "General Orders",
    url: "https://lawphil.net/executive/genor/genor.html",
    category: "executive_issuance",
    idPrefix: "lawphil-go",
    tags: ["lawphil", "executive issuances", "general orders"],
    authorityLevel: 84,
  },
];

const CONSTITUTION_TARGETS: ConstitutionTarget[] = [
  { title: "Malolos Constitution", url: "https://lawphil.net/consti/consmalo.html" },
  { title: "1935 Constitution", url: "https://lawphil.net/consti/cons1935.html" },
  { title: "1943 Constitution", url: "https://lawphil.net/consti/cons1943.html" },
  { title: "1973 Constitution", url: "https://lawphil.net/consti/cons1973.html" },
  { title: "1986 Constitution", url: "https://lawphil.net/consti/cons1986.html" },
  { title: "1987 Constitution", url: "https://lawphil.net/consti/cons1987.html" },
];

function toBoundedInt(input: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(input);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function extractDate(value: string): string | undefined {
  const normalized = normalizeWhitespace(value);
  const matched = normalized.match(DATE_PATTERN)?.[0];
  return mapDate(matched);
}

function parseMonthToken(value: string): string | undefined {
  const normalized = normalizeWhitespace(value).toLowerCase();

  if (!normalized) {
    return undefined;
  }

  const token = normalized.slice(0, 3);
  return MONTH_ORDER[token] ? token : undefined;
}

function getPathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function buildDedupeKey(record: Pick<LawRecord, "title" | "lawNumber" | "sourceUrl">): string {
  const normalizedLawNumber = normalizeWhitespace(record.lawNumber ?? "").toLowerCase();
  const normalizedTitle = normalizeWhitespace(record.title).toLowerCase();
  const normalizedUrl = normalizeWhitespace(record.sourceUrl).toLowerCase();

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

function extractPdfUrl(row: RowLike): string | undefined {
  const direct = row.find('a[href*=".pdf"]').first().attr("href");

  if (direct && /\.pdf(?:$|[?#])/i.test(direct)) {
    return direct;
  }

  const legacy = row.find('a[xref*=".pdf"]').first().attr("xref");

  if (legacy && /\.pdf(?:$|[?#])/i.test(legacy)) {
    return legacy;
  }

  return undefined;
}

function isLikelyJurisprudenceDocket(value: string): boolean {
  const normalized = normalizeWhitespace(value);

  if (!normalized || !/\d/.test(normalized)) {
    return false;
  }

  return /(\bno\.?\b|g\.r\.|a\.m\.|a\.c\.|b\.m\.|udk|rtj|mtj|bar matter|jib|oca)/i.test(normalized);
}

async function scrapeIndexTarget(
  target: LawphilIndexTarget,
  records: LawRecord[],
  seen: Set<string>,
  warnings: string[],
) {
  try {
    const $ = await fetchDom(target.url);
    let added = 0;

    $("#s-menu tr").each((_, element) => {
      if (added >= MAX_ROWS_PER_INDEX_PAGE || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        return false;
      }

      const row = $(element);
      const cells = row.find("td");

      if (cells.length < 2) {
        return;
      }

      const numberCell = cells.eq(0);
      const detailCell = cells.eq(1);
      const anchor = numberCell.find('a[href*=".html"]').first();
      const href = anchor.attr("href");
      const lawNumber = safeText(anchor);

      if (!href || !lawNumber || !INDEX_PATH_PATTERN.test(href)) {
        return;
      }

      const sourceUrl = absoluteUrl(target.url, href);

      if (!sourceUrl.includes("lawphil.net")) {
        return;
      }

      const summary = safeText(detailCell) || `${lawNumber} indexed from Lawphil ${target.label}.`;
      const enactedOn = extractDate(numberCell.text());
      const pdfPath = extractPdfUrl(row);
      const sourcePdfUrl = pdfPath ? absoluteUrl(target.url, pdfPath) : undefined;

      const rowRecord: LawRecord = {
        id: toLawId(target.idPrefix, `${lawNumber}-${sourceUrl}`),
        title: lawNumber,
        lawNumber,
        category: target.category,
        summary,
        enactedOn,
        source: "lawphil",
        sourceUrl,
        sourcePdfUrl,
        tags: sourcePdfUrl ? [...target.tags, "source pdf"] : target.tags,
        fullTextPreview: summary,
        isPrimarySource: false,
        freshness: "stale",
        lastVerifiedAt: nowIso(),
        authorityLevel: target.authorityLevel,
      };

      if (pushRecord(records, seen, rowRecord)) {
        added += 1;
      }
    });

    if (!added) {
      warnings.push(`No rows parsed for Lawphil ${target.label} index (${target.url}).`);
    }
  } catch (error) {
    warnings.push(
      `Lawphil ${target.label} scrape failed (${target.url}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
    );
  }
}

function parseJurisprudenceYearLinks($: Awaited<ReturnType<typeof fetchDom>>): YearLink[] {
  const byYear = new Map<number, string>();
  const currentYear = new Date().getUTCFullYear();

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const label = safeText(anchor);
    const href = anchor.attr("href");

    if (!href || !/^\d{4}$/.test(label)) {
      return;
    }

    const year = Number(label);

    if (!Number.isFinite(year) || year < 1900 || year > currentYear) {
      return;
    }

    const absolute = absoluteUrl(JURISPRUDENCE_ROOT_URL, href);

    if (!YEAR_PAGE_PATH_PATTERN.test(getPathname(absolute))) {
      return;
    }

    byYear.set(year, absolute);
  });

  return Array.from(byYear.entries())
    .map(([year, url]) => ({ year, url }))
    .sort((left, right) => right.year - left.year)
    .slice(0, MAX_JURISPRUDENCE_YEARS);
}

function parseJurisprudenceMonthLinks(
  $: Awaited<ReturnType<typeof fetchDom>>,
  yearUrl: string,
): MonthLink[] {
  const months = new Map<string, MonthLink>();

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");

    if (!href) {
      return;
    }

    const url = absoluteUrl(yearUrl, href);
    const pathname = getPathname(url);

    if (!MONTH_PAGE_PATH_PATTERN.test(pathname)) {
      return;
    }

    const fromPath = pathname.match(MONTH_PAGE_PATH_PATTERN)?.[1]?.toLowerCase();
    const fromLabel = parseMonthToken(safeText(anchor));
    const monthToken = fromPath ?? fromLabel;

    if (!monthToken) {
      return;
    }

    const monthValue = MONTH_ORDER[monthToken];

    if (!monthValue) {
      return;
    }

    const label = safeText(anchor) || monthToken;

    months.set(url, {
      label,
      month: monthValue,
      url,
    });
  });

  return Array.from(months.values())
    .sort((left, right) => right.month - left.month)
    .slice(0, MAX_JURISPRUDENCE_MONTHS_PER_YEAR);
}

async function scrapeJurisprudence(
  records: LawRecord[],
  seen: Set<string>,
  warnings: string[],
) {
  let added = 0;

  try {
    const $ = await fetchDom(JURISPRUDENCE_ROOT_URL);
    const yearLinks = parseJurisprudenceYearLinks($);

    if (!yearLinks.length) {
      warnings.push("No Lawphil jurisprudence year links were parsed from judjuris.html.");
      return;
    }

    for (const yearLink of yearLinks) {
      if (added >= MAX_JURISPRUDENCE_RECORDS || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        break;
      }

      try {
        const yearPage = await fetchDom(yearLink.url);
        const monthLinks = parseJurisprudenceMonthLinks(yearPage, yearLink.url);

        if (!monthLinks.length) {
          warnings.push(`No month links parsed for Lawphil jurisprudence year ${yearLink.year}.`);
          continue;
        }

        for (const monthLink of monthLinks) {
          if (added >= MAX_JURISPRUDENCE_RECORDS || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
            break;
          }

          try {
            const monthPage = await fetchDom(monthLink.url);

            monthPage("#s-menu tr").each((_, element) => {
              if (added >= MAX_JURISPRUDENCE_RECORDS || records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
                return false;
              }

              const row = monthPage(element);
              const cells = row.find("td");

              if (cells.length < 2) {
                return;
              }

              const numberCell = cells.eq(0);
              const caseAnchor = numberCell.find('a[href*=".html"]').first();
              const href = caseAnchor.attr("href");
              const docket = safeText(caseAnchor);

              if (!href || !docket || !INDEX_PATH_PATTERN.test(href) || !isLikelyJurisprudenceDocket(docket)) {
                return;
              }

              const sourceUrl = absoluteUrl(monthLink.url, href);

              if (!sourceUrl.includes("lawphil.net")) {
                return;
              }

              const caseTitle = safeText(cells.eq(1));
              const summary = caseTitle || `Jurisprudence entry indexed by Lawphil for ${docket}.`;
              const enactedOn = extractDate(numberCell.text());
              const pdfPath = extractPdfUrl(row);
              const sourcePdfUrl = pdfPath ? absoluteUrl(monthLink.url, pdfPath) : undefined;

              const rowRecord: LawRecord = {
                id: toLawId("lawphil-juris", `${docket}-${sourceUrl}`),
                title: caseTitle || docket,
                lawNumber: docket,
                category: "jurisprudence",
                summary,
                enactedOn,
                source: "lawphil",
                sourceUrl,
                sourcePdfUrl,
                tags: sourcePdfUrl
                  ? ["lawphil", "jurisprudence", `year:${yearLink.year}`, `month:${monthLink.label.toLowerCase()}`, "source pdf"]
                  : ["lawphil", "jurisprudence", `year:${yearLink.year}`, `month:${monthLink.label.toLowerCase()}`],
                fullTextPreview: summary,
                isPrimarySource: false,
                freshness: "stale",
                lastVerifiedAt: nowIso(),
                authorityLevel: 84,
              };

              if (pushRecord(records, seen, rowRecord)) {
                added += 1;
              }
            });
          } catch (error) {
            warnings.push(
              `Lawphil jurisprudence month scrape failed (${monthLink.url}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
            );
          }
        }
      } catch (error) {
        warnings.push(
          `Lawphil jurisprudence year scrape failed (${yearLink.url}): ${error instanceof Error ? error.message : "Unknown scrape error"}`,
        );
      }
    }

    if (!added) {
      warnings.push("No Lawphil jurisprudence case entries were parsed from year/month listings.");
    }
  } catch (error) {
    warnings.push(
      `Lawphil jurisprudence root scrape failed: ${error instanceof Error ? error.message : "Unknown scrape error"}`,
    );
  }
}

function addConstitutionRecords(records: LawRecord[], seen: Set<string>) {
  for (const target of CONSTITUTION_TARGETS) {
    if (records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
      break;
    }

    const record: LawRecord = {
      id: toLawId("lawphil-constitution", target.title),
      title: target.title,
      lawNumber: target.title,
      category: "constitution",
      summary: `Full text of the ${target.title} indexed by The Lawphil Project.`,
      source: "lawphil",
      sourceUrl: target.url,
      tags: ["lawphil", "constitution"],
      fullTextPreview: `${target.title} constitutional text index entry from Lawphil.`,
      isPrimarySource: false,
      freshness: "stale",
      lastVerifiedAt: nowIso(),
      authorityLevel: 84,
    };

    pushRecord(records, seen, record);
  }
}

export async function scrapeLawphil(): Promise<ScrapeResult> {
  const warnings: string[] = [];
  const records: LawRecord[] = [];
  const seen = new Set<string>();

  try {
    for (const target of STATUTE_TARGETS) {
      if (records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        break;
      }

      await scrapeIndexTarget(target, records, seen, warnings);
    }

    addConstitutionRecords(records, seen);

    if (records.length < MAX_TOTAL_RECORDS_PER_RUN) {
      await scrapeJurisprudence(records, seen, warnings);
    }

    for (const target of EXECUTIVE_TARGETS) {
      if (records.length >= MAX_TOTAL_RECORDS_PER_RUN) {
        break;
      }

      await scrapeIndexTarget(target, records, seen, warnings);
    }

    if (!records.length) {
      warnings.push("No records parsed from Lawphil section indexes.");
    }

    if (records.length && ENRICH_MAX_RECORDS > 0) {
      await enrichRecordsWithArticleText(records, {
        warnings,
        sourceLabel: "lawphil",
        maxRecords: Math.min(ENRICH_MAX_RECORDS, records.length),
        minTextLength: 240,
        maxTextLength: 26000,
      });
    }

    return {
      source: "lawphil",
      records,
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "lawphil",
      records,
      warnings,
    };
  }
}
