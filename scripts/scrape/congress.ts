import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LawRecord } from "../../types/law";

import { loadScrapeCheckpoint, patchScrapeCheckpoint } from "./checkpoint";
import { normalizeWhitespace, nowIso, ScrapeResult, toLawId } from "./shared";

const CONGRESS_PORTAL_URL = "https://www.congress.gov.ph/";
const DOCS_BASE_URL = "https://docs.congress.hrep.online/legisdocs";
const MIN_CONGRESS = Math.max(1, Number(process.env.CONGRESS_MIN_CONGRESS ?? 8));
const MAX_CONGRESS = Math.max(MIN_CONGRESS, Number(process.env.CONGRESS_MAX_CONGRESS ?? 20));
const MAX_RECORDS_PER_RUN = Math.min(
  Math.max(Number(process.env.CONGRESS_MAX_RECORDS_PER_RUN ?? 420), 20),
  4000,
);
const MAX_PROBES_PER_STREAM = Math.min(
  Math.max(Number(process.env.CONGRESS_MAX_PROBES_PER_STREAM ?? 120), 10),
  1200,
);
const MAX_CONSECUTIVE_MISSES = Math.min(
  Math.max(Number(process.env.CONGRESS_MAX_CONSECUTIVE_MISSES ?? 20), 3),
  80,
);
const CONGRESS_PDF_RECORD_LIMIT = Math.min(
  Math.max(Number(process.env.CONGRESS_PDF_TEXT_RECORD_LIMIT ?? 40), 0),
  250,
);
const CONGRESS_PDF_FETCH_MAX_BYTES = Math.min(
  Math.max(Number(process.env.CONGRESS_PDF_FETCH_MAX_BYTES ?? 24 * 1024 * 1024), 256 * 1024),
  50 * 1024 * 1024,
);
const CONGRESS_PDF_MIN_TEXT_LENGTH = Math.max(Number(process.env.CONGRESS_PDF_MIN_TEXT_LENGTH ?? 120), 40);
const CONGRESS_PDF_MAX_TEXT_LENGTH = Math.max(Number(process.env.CONGRESS_PDF_MAX_TEXT_LENGTH ?? 24000), 1200);
const MAX_EXTRACTION_WARNINGS = 12;

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

type PdfTextExtractor = (data: Buffer) => Promise<string | undefined>;

let cachedPdfTextExtractor: PdfTextExtractor | null | undefined;

interface CongressDocumentFamily {
  key: "hb" | "hr" | "ra" | "cr";
  label: string;
  listingUrl: string;
  sourcePathLabel: string;
  code: string;
  codePadLength: number;
  category: LawRecord["category"];
  authorityLevel: number;
  folderForCongress: (congress: number) => string;
  lawNumberFor: (number: number) => string;
}

const DOCUMENT_FAMILIES: CongressDocumentFamily[] = [
  {
    key: "hb",
    label: "House Bill",
    listingUrl: "https://www.congress.gov.ph/legislative-documents/",
    sourcePathLabel: "House Bills and Resolutions",
    code: "HB",
    codePadLength: 5,
    category: "bill",
    authorityLevel: 93,
    folderForCongress: (congress) => `basic_${congress}`,
    lawNumberFor: (number) => `HB-${String(number).padStart(5, "0")}`,
  },
  {
    key: "hr",
    label: "Adopted Resolution",
    listingUrl: "https://www.congress.gov.ph/legislative-documents/adopted-resolutions/",
    sourcePathLabel: "Adopted Resolutions",
    code: "HR",
    codePadLength: 5,
    category: "bill",
    authorityLevel: 91,
    folderForCongress: (congress) => `basic_${congress}`,
    lawNumberFor: (number) => `HR-${String(number).padStart(5, "0")}`,
  },
  {
    key: "ra",
    label: "Republic Act",
    listingUrl: "https://www.congress.gov.ph/legislative-documents/republic-acts/",
    sourcePathLabel: "Republic Acts",
    code: "RA",
    codePadLength: 0,
    category: "republic_act",
    authorityLevel: 97,
    folderForCongress: (congress) => `ra_${congress}`,
    lawNumberFor: (number) => `RA ${number}`,
  },
  {
    key: "cr",
    label: "Committee Report",
    listingUrl: "https://www.congress.gov.ph/committees/reports/",
    sourcePathLabel: "Committee Reports",
    code: "CR",
    codePadLength: 5,
    category: "other",
    authorityLevel: 90,
    folderForCongress: (congress) => `first_${congress}`,
    lawNumberFor: (number) => `CR-${String(number).padStart(5, "0")}`,
  },
];

interface ProbeOutcome {
  exists: boolean;
  status?: number;
}

function pushLimitedWarning(warnings: string[], warning: string) {
  if (warnings.length >= MAX_EXTRACTION_WARNINGS) {
    return;
  }

  warnings.push(warning);
}

function normalizePdfText(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanCongressPdfText(input: string): string {
  const compact = normalizePdfText(input);

  if (!compact) {
    return "";
  }

  const lines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[- ]*\d+\s+of\s+\d+[- ]*$/i.test(line))
    .filter((line) => !/^\d+\s+of\s+\d+$/i.test(line))
    .filter((line) => !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(am|pm)$/i.test(line));

  return normalizePdfText(lines.join("\n"));
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

function summaryLooksGeneric(summary: string): boolean {
  const normalized = summary.toLowerCase();
  return normalized.includes("from the official congress document repository") || normalized.length < 80;
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
        return text || undefined;
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
          return text || undefined;
        } finally {
          if (parser.destroy) {
            await parser.destroy().catch(() => undefined);
          }
        }
      };

      return cachedPdfTextExtractor;
    }

    cachedPdfTextExtractor = null;
    pushLimitedWarning(warnings, "Congress PDF extraction unavailable: unsupported pdf-parse export shape.");
    return null;
  } catch (error) {
    cachedPdfTextExtractor = null;
    pushLimitedWarning(
      warnings,
      `Congress PDF extraction unavailable: ${error instanceof Error ? error.message : "Unknown parser load error"}`,
    );
    return null;
  }
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

  const announcedLength = Number(response.headers.get("content-length") ?? "0");

  if (Number.isFinite(announcedLength) && announcedLength > CONGRESS_PDF_FETCH_MAX_BYTES) {
    throw new Error(`PDF exceeds max size limit (${announcedLength} bytes).`);
  }

  const binary = Buffer.from(await response.arrayBuffer());

  if (!binary.length) {
    throw new Error("PDF response body was empty.");
  }

  if (binary.length > CONGRESS_PDF_FETCH_MAX_BYTES) {
    throw new Error(`PDF exceeds max size limit (${binary.length} bytes).`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const hasPdfMagicHeader = binary.subarray(0, 4).toString("utf8") === "%PDF";

  if (!hasPdfMagicHeader && !contentType.includes("application/pdf")) {
    throw new Error(`Expected PDF content but got ${contentType || "unknown content type"}.`);
  }

  return binary;
}

async function enrichCongressRecordsWithPdf(records: LawRecord[], warnings: string[]) {
  if (!CONGRESS_PDF_RECORD_LIMIT) {
    return;
  }

  const extractor = await getPdfTextExtractor(warnings);

  if (!extractor) {
    return;
  }

  let enrichedCount = 0;

  for (const record of records.slice(0, CONGRESS_PDF_RECORD_LIMIT)) {
    const pdfUrl = record.sourcePdfUrl;

    if (!pdfUrl) {
      continue;
    }

    try {
      const binary = await fetchPdfBinary(pdfUrl);
      const parsedTextRaw = await extractor(binary);
      const parsedText = parsedTextRaw ? cleanCongressPdfText(parsedTextRaw) : undefined;

      if (!parsedText || parsedText.length < CONGRESS_PDF_MIN_TEXT_LENGTH) {
        continue;
      }

      const fullText = truncateAtWord(parsedText, CONGRESS_PDF_MAX_TEXT_LENGTH);
      record.fullText = fullText;
      record.fullTextPreview = truncateAtWord(fullText, 600);

      if (summaryLooksGeneric(record.summary)) {
        const summary = summarizeText(fullText);

        if (summary) {
          record.summary = summary;
        }
      }

      if (!record.tags.includes("pdf text")) {
        record.tags = [...record.tags, "pdf text"];
      }

      enrichedCount += 1;
    } catch (error) {
      pushLimitedWarning(
        warnings,
        `Congress PDF extraction failed for ${record.title}: ${error instanceof Error ? error.message : "Unknown parse error"}`,
      );
    }
  }

  if (!enrichedCount && records.length > 0) {
    pushLimitedWarning(warnings, "Congress PDF links were discovered but yielded no extractable text in sampled records.");
  }
}

function congressRangeDescending(minCongress: number, maxCongress: number): number[] {
  const values: number[] = [];

  for (let congress = maxCongress; congress >= minCongress; congress -= 1) {
    values.push(congress);
  }

  return values;
}

function buildDocumentFileNames(family: CongressDocumentFamily, number: number): string[] {
  if (family.key === "ra") {
    const noPad = `${family.code}${number}.pdf`;
    const padded = `${family.code}${String(number).padStart(5, "0")}.pdf`;
    return noPad === padded ? [noPad] : [noPad, padded];
  }

  return [`${family.code}${String(number).padStart(family.codePadLength, "0")}.pdf`];
}

function cursorKey(family: CongressDocumentFamily, congress: number): string {
  return `${family.key}:${congress}`;
}

function buildRecord(input: {
  family: CongressDocumentFamily;
  congress: number;
  number: number;
  pdfUrl: string;
}): LawRecord {
  const { family, congress, number, pdfUrl } = input;
  const lawNumber = family.lawNumberFor(number);

  return {
    id: toLawId("congress", `${family.code}-${congress}-${number}`),
    title: `${family.label} ${lawNumber} (Congress ${congress})`,
    lawNumber,
    category: family.category,
    summary: `${family.label} from the official Congress document repository (${family.sourcePathLabel}, ${congress}th Congress).`,
    source: "congress",
    sourceUrl: pdfUrl,
    sourcePdfUrl: pdfUrl,
    tags: [
      "congress",
      "philippines",
      family.key,
      family.label.toLowerCase(),
      `${congress}th congress`,
      family.sourcePathLabel.toLowerCase(),
    ],
    fullTextPreview: `Primary PDF document: ${pdfUrl}`,
    isPrimarySource: true,
    freshness: "fresh",
    lastVerifiedAt: nowIso(),
    authorityLevel: family.authorityLevel,
    relatedDocumentIds: [`${family.code}-${congress}-${number}`],
  };
}

async function probePdf(url: string): Promise<ProbeOutcome> {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept: "application/pdf,*/*;q=0.8",
  };

  try {
    const headResponse = await fetch(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
    });

    if (headResponse.ok) {
      return { exists: true, status: headResponse.status };
    }

    if (headResponse.status !== 403 && headResponse.status !== 405) {
      return { exists: false, status: headResponse.status };
    }
  } catch {
    // Fall through to GET range fallback.
  }

  try {
    const getResponse = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        range: "bytes=0-0",
      },
      redirect: "follow",
    });

    return { exists: getResponse.ok || getResponse.status === 206, status: getResponse.status };
  } catch {
    return { exists: false };
  }
}

export async function scrapeCongressPortal(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  try {
    const portalResponse = await fetch("https://www.congress.gov.ph/legislative-documents/", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
    const records: LawRecord[] = [];
    const checkpoint = await loadScrapeCheckpoint();
    const nextCongressCursor = { ...checkpoint.congressCursor };

    if (portalResponse.status === 403) {
      warnings.push(
        "Congress listing pages returned HTTP 403. Falling back to direct PDF probing on docs.congress.hrep.online.",
      );
    } else if (!portalResponse.ok) {
      warnings.push(`Congress listing probe responded with status ${portalResponse.status}. Using direct PDF probing.`);
    }

    const seen = new Set<string>();
    const congresses = congressRangeDescending(MIN_CONGRESS, MAX_CONGRESS);
    const maxCongressSlots = Math.max(1, congresses.length);
    const maxRecordsPerCongress = Math.min(
      Math.max(
        Number(process.env.CONGRESS_MAX_RECORDS_PER_CONGRESS_PER_RUN ?? Math.ceil(MAX_RECORDS_PER_RUN / maxCongressSlots)),
        1,
      ),
      MAX_RECORDS_PER_RUN,
    );

    for (const congress of congresses) {
      if (records.length >= MAX_RECORDS_PER_RUN) {
        break;
      }

      let congressAdded = 0;

      for (const family of DOCUMENT_FAMILIES) {
        if (records.length >= MAX_RECORDS_PER_RUN || congressAdded >= maxRecordsPerCongress) {
          break;
        }

        const remainingCongressBudget = Math.max(0, maxRecordsPerCongress - congressAdded);
        const remainingGlobalBudget = Math.max(0, MAX_RECORDS_PER_RUN - records.length);
        const familyCap = Math.max(1, Math.min(remainingCongressBudget, remainingGlobalBudget));

        const key = cursorKey(family, congress);
        const savedState = nextCongressCursor[key];
        const initialNext = savedState?.nextNumber ?? 1;

        let nextNumber = Math.max(1, initialNext);
        let consecutiveMisses = Math.max(0, savedState?.consecutiveMisses ?? 0);
        let lastHitNextNumber: number | undefined;
        let probes = 0;
        let recordsAddedForFamily = 0;

        while (
          records.length < MAX_RECORDS_PER_RUN &&
          recordsAddedForFamily < familyCap &&
          probes < MAX_PROBES_PER_STREAM &&
          consecutiveMisses < MAX_CONSECUTIVE_MISSES
        ) {
          probes += 1;

          const folder = family.folderForCongress(congress);
          const fileNames = buildDocumentFileNames(family, nextNumber);

          let matchedPdfUrl: string | undefined;

          for (const fileName of fileNames) {
            const candidateUrl = `${DOCS_BASE_URL}/${folder}/${fileName}`;
            const result = await probePdf(candidateUrl);

            if (result.exists) {
              matchedPdfUrl = candidateUrl;
              break;
            }

            if (result.status === 429) {
              warnings.push(
                `Rate limited while probing ${family.label} Congress ${congress}. Stopping this stream for now.`,
              );
              consecutiveMisses = MAX_CONSECUTIVE_MISSES;
              break;
            }
          }

          if (matchedPdfUrl) {
            const dedupeKey = `${family.key}|${congress}|${nextNumber}`;

            if (!seen.has(dedupeKey)) {
              seen.add(dedupeKey);
              records.push(
                buildRecord({
                  family,
                  congress,
                  number: nextNumber,
                  pdfUrl: matchedPdfUrl,
                }),
              );
              recordsAddedForFamily += 1;
              congressAdded += 1;
            }

            nextNumber += 1;
            consecutiveMisses = 0;
            lastHitNextNumber = nextNumber;
            continue;
          }

          nextNumber += 1;
          consecutiveMisses += 1;
        }

        if (lastHitNextNumber !== undefined) {
          nextNumber = lastHitNextNumber;
        } else if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          nextNumber = initialNext;
        }

        nextCongressCursor[key] = {
          nextNumber,
          consecutiveMisses: Math.min(consecutiveMisses, MAX_CONSECUTIVE_MISSES),
        };
      }
    }

    try {
      await patchScrapeCheckpoint({ congressCursor: nextCongressCursor });
    } catch (error) {
      warnings.push(
        `Unable to persist congress cursor checkpoint: ${error instanceof Error ? error.message : "Unknown checkpoint error"}`,
      );
    }

    if (!records.length) {
      warnings.push(
        "No Congress PDF records discovered in this run. Increase probes or verify current congress range configuration.",
      );
    }

    if (records.length) {
      await enrichCongressRecordsWithPdf(records, warnings);
    }

    if (portalResponse.status === 403 && !records.length) {
      records.push({
        id: toLawId("congress", "blocked-listing-fallback-empty"),
        title: "Congress Legislative Portal accessibility",
        category: "other",
        summary:
          "Listing pages are blocked (HTTP 403) and direct PDF probing did not discover records during this run.",
        source: "congress",
        sourceUrl: CONGRESS_PORTAL_URL,
        tags: ["congress", "access", "blocked", "fallback"],
        isPrimarySource: true,
        freshness: "blocked",
        lastVerifiedAt: nowIso(),
        authorityLevel: 88,
      });
    }

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

async function runStandalone() {
  const result = await scrapeCongressPortal();
  const outputPath = path.resolve(process.cwd(), "data", "congress.records.json");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result.records, null, 2), "utf8");

  console.log(`Congress records: ${result.records.length}`);

  if (result.warnings.length) {
    console.log(`Warnings: ${result.warnings.join(" | ")}`);
  }
}

if (process.argv.includes("--run")) {
  runStandalone().catch((error) => {
    console.error("Congress scrape failed:", error);
    process.exitCode = 1;
  });
}
