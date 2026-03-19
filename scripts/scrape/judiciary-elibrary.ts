import type { LawRecord } from "../../types/law";

import { loadScrapeCheckpoint, patchScrapeCheckpoint } from "./checkpoint";
import {
  absoluteUrl,
  enrichRecordsWithArticleText,
  fetchDom,
  mapDate,
  nowIso,
  normalizeWhitespace,
  ScrapeResult,
  toLawId,
} from "./shared";

const SOURCE_URL = "https://elibrary.judiciary.gov.ph/republic_acts";
const FETCH_ENDPOINT = "https://elibrary.judiciary.gov.ph/republic_acts/fetch_ra";
const PAGE_SIZE = Math.min(Math.max(Number(process.env.JUDICIARY_PAGE_SIZE ?? 120), 50), 300);
const MAX_RECORDS_PER_RUN = Math.min(
  Math.max(Number(process.env.JUDICIARY_MAX_RECORDS_PER_RUN ?? 900), PAGE_SIZE),
  6000,
);
const MAX_PAGES_PER_RUN = Math.min(Math.max(Number(process.env.JUDICIARY_MAX_PAGES_PER_RUN ?? 16), 1), 80);

interface JudiciaryDataTablePayload {
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  data?: Array<[string, string, string]>;
}

function parseLawNumber(title: string): string | undefined {
  const matched = title.match(/REPUBLIC ACT NO\.\s*\d+/i);
  return matched?.[0]?.replace(/\./g, "");
}

function stripHtml(value: string): string {
  return normalizeWhitespace(value.replace(/<[^>]+>/g, " "));
}

function extractHref(value: string): string | undefined {
  const singleQuoteMatch = value.match(/href='([^']+)'/i)?.[1];
  const doubleQuoteMatch = value.match(/href=\"([^\"]+)\"/i)?.[1];

  return singleQuoteMatch ?? doubleQuoteMatch;
}

function buildFetchUrl(start: number, length: number, draw: number): string {
  const url = new URL(FETCH_ENDPOINT);
  url.searchParams.set("draw", String(draw));
  url.searchParams.set("start", String(start));
  url.searchParams.set("length", String(length));
  url.searchParams.set("search[value]", "");
  url.searchParams.set("search[regex]", "false");
  return url.toString();
}

function parsePayload(text: string): JudiciaryDataTablePayload | null {
  const jsonStart = text.indexOf('{"draw"');

  if (jsonStart < 0) {
    return null;
  }

  try {
    return JSON.parse(text.slice(jsonStart)) as JudiciaryDataTablePayload;
  } catch {
    return null;
  }
}

function pushRowRecord(records: LawRecord[], seen: Set<string>, row: [string, string, string]) {
  const title = normalizeWhitespace(row[0] ?? "");
  const dateText = normalizeWhitespace(row[1] ?? "");
  const summaryHtml = row[2] ?? "";
  const summary = stripHtml(summaryHtml);
  const rowHref = extractHref(summaryHtml);

  if (!title) {
    return;
  }

  const key = title.toLowerCase();

  if (seen.has(key)) {
    return;
  }

  seen.add(key);

  records.push({
    id: toLawId("elibrary", parseLawNumber(title) ?? title),
    title,
    lawNumber: parseLawNumber(title),
    category: /republic act/i.test(title) ? "republic_act" : "other",
    summary: summary || "Entry indexed in Supreme Court E-Library Republic Acts catalog.",
    enactedOn: mapDate(dateText),
    source: "judiciary_elibrary",
    sourceUrl: absoluteUrl(SOURCE_URL, rowHref),
    tags: ["supreme court", "e-library", "republic acts"],
    fullTextPreview: summary,
    isPrimarySource: true,
    freshness: "fresh",
    lastVerifiedAt: nowIso(),
    authorityLevel: 96,
  });
}

export async function scrapeJudiciaryElibrary(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  try {
    const records: LawRecord[] = [];
    const seen = new Set<string>();
    const checkpoint = await loadScrapeCheckpoint();

    let start = checkpoint.judiciaryStart;
    let draw = 1;
    let totalAvailable: number | undefined;

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_RUN && records.length < MAX_RECORDS_PER_RUN; pageIndex += 1) {
      const endpointResponse = await fetch(buildFetchUrl(start, PAGE_SIZE, draw), {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          accept: "application/json,text/javascript,*/*;q=0.01",
          "x-requested-with": "XMLHttpRequest",
        },
      });

      if (!endpointResponse.ok) {
        warnings.push(`Judiciary fetch endpoint returned status ${endpointResponse.status}.`);
        break;
      }

      const payloadText = await endpointResponse.text();
      const payload = parsePayload(payloadText);

      if (!payload) {
        warnings.push("Judiciary endpoint did not return parseable JSON payload.");
        break;
      }

      if (typeof payload.recordsTotal === "number" && Number.isFinite(payload.recordsTotal)) {
        totalAvailable = payload.recordsTotal;
      }

      const rows = payload.data ?? [];

      if (!rows.length) {
        start = 0;
        break;
      }

      for (const row of rows) {
        pushRowRecord(records, seen, row);
      }

      start += rows.length;
      draw += 1;

      if (rows.length < PAGE_SIZE) {
        start = 0;
        break;
      }

      if (typeof totalAvailable === "number" && start >= totalAvailable) {
        start = 0;
        break;
      }
    }

    if (!records.length) {
      const $ = await fetchDom(SOURCE_URL);

      $("table tbody tr").each((_, element) => {
        const row = $(element);
        const columns = row.find("td");

        if (columns.length < 2) {
          return;
        }

        const title = normalizeWhitespace($(columns[0]).text());
        const dateText = normalizeWhitespace($(columns[1]).text());
        const summary = normalizeWhitespace($(columns[2]).text());

        if (!title) {
          return;
        }

        const key = title.toLowerCase();

        if (seen.has(key)) {
          return;
        }

        seen.add(key);

        records.push({
          id: toLawId("elibrary", parseLawNumber(title) ?? title),
          title,
          lawNumber: parseLawNumber(title),
          category: /republic act/i.test(title) ? "republic_act" : "other",
          summary: summary || "Entry indexed in Supreme Court E-Library Republic Acts catalog.",
          enactedOn: mapDate(dateText),
          source: "judiciary_elibrary",
          sourceUrl: SOURCE_URL,
          tags: ["supreme court", "e-library", "republic acts"],
          fullTextPreview: summary,
          isPrimarySource: true,
          freshness: "fresh",
          lastVerifiedAt: nowIso(),
          authorityLevel: 95,
        });
      });

      start = 0;
    }

    try {
      await patchScrapeCheckpoint({ judiciaryStart: start });
    } catch (error) {
      warnings.push(
        `Unable to persist judiciary checkpoint: ${error instanceof Error ? error.message : "Unknown checkpoint error"}`,
      );
    }

    if (!records.length) {
      warnings.push("No rows parsed from judiciary e-library table or fallback text parser.");
    }

    if (records.length) {
      await enrichRecordsWithArticleText(records, {
        warnings,
        sourceLabel: "judiciary e-library",
        maxRecords: 140,
        minTextLength: 200,
        maxTextLength: 28000,
      });
    }

    return {
      source: "judiciary_elibrary",
      records: records.slice(0, MAX_RECORDS_PER_RUN),
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "judiciary_elibrary",
      records: [],
      warnings,
    };
  }
}
