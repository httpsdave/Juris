import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LawRecord } from "../../types/law";

import { loadScrapeCheckpoint, patchScrapeCheckpoint } from "./checkpoint";
import { nowIso, ScrapeResult, toLawId } from "./shared";

const API_BASE = process.env.OPEN_CONGRESS_API_BASE ?? "https://open-congress-api.bettergov.ph/api";
const DEFAULT_PAGE_SIZE = Math.min(Math.max(Number(process.env.OPEN_CONGRESS_PAGE_SIZE ?? 100), 40), 100);
const MAX_RECORDS_PER_RUN = Math.min(
  Math.max(Number(process.env.OPEN_CONGRESS_MAX_RECORDS_PER_RUN ?? 1200), DEFAULT_PAGE_SIZE),
  10000,
);
const MAX_PAGES_PER_RUN = Math.min(Math.max(Number(process.env.OPEN_CONGRESS_MAX_PAGES_PER_RUN ?? 14), 1), 120);

interface OpenCongressEnvelope<T> {
  success: boolean;
  data: T;
}

interface OpenCongressDocument {
  id?: string;
  subtype?: string;
  name?: string;
  bill_number?: number;
  congress?: number;
  title?: string;
  long_title?: string;
  date_filed?: string;
  scope?: string;
}

function buildRecord(document: OpenCongressDocument): { record: LawRecord; dedupeKey: string } {
  const title = document.title || document.long_title || document.name || "Untitled document";
  const longText = document.long_title || document.title || "";
  const billLabel =
    document.name ||
    (document.bill_number && document.subtype
      ? `${document.subtype.toUpperCase()}-${String(document.bill_number).padStart(5, "0")}`
      : undefined);
  const dedupeKey = [document.id, document.congress, document.subtype, document.bill_number, billLabel, title]
    .filter((value) => value !== undefined && value !== null && String(value).length > 0)
    .join("|")
    .toLowerCase();

  return {
    dedupeKey,
    record: {
      id: toLawId("open-congress", document.id || title),
      title,
      lawNumber: billLabel,
      category: "bill",
      summary: longText || "Legislative document from Open Congress API.",
      enactedOn: document.date_filed,
      source: "open_congress",
      sourceUrl: `${API_BASE}/documents/${document.id ?? ""}`,
      tags: ["open congress", "bill", document.subtype?.toLowerCase() ?? "document"],
      fullTextPreview: longText,
      fullText: longText || undefined,
      isPrimarySource: false,
      freshness: "api",
      lastVerifiedAt: nowIso(),
      authorityLevel: 86,
      relatedDocumentIds: document.id ? [document.id] : undefined,
    },
  };
}

export async function scrapeOpenCongress(limit = DEFAULT_PAGE_SIZE): Promise<ScrapeResult> {
  const warnings: string[] = [];
  const pageSize = Math.min(Math.max(Math.floor(limit), 20), 100);

  try {
    const checkpoint = await loadScrapeCheckpoint();
    const records: LawRecord[] = [];
    const seen = new Set<string>();

    let offset = checkpoint.openCongressOffset;
    let pagesFetched = 0;
    let resetAttempted = false;

    while (pagesFetched < MAX_PAGES_PER_RUN && records.length < MAX_RECORDS_PER_RUN) {
      const documentsUrl = new URL(`${API_BASE}/documents`);
      documentsUrl.searchParams.set("limit", String(pageSize));
      documentsUrl.searchParams.set("offset", String(offset));
      documentsUrl.searchParams.set("sort", "date_filed");
      documentsUrl.searchParams.set("dir", "desc");

      const response = await fetch(documentsUrl.toString(), {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        warnings.push(`Open Congress documents endpoint failed: ${response.status}`);
        break;
      }

      const payload = (await response.json()) as OpenCongressEnvelope<OpenCongressDocument[]>;

      if (!payload.success || !Array.isArray(payload.data)) {
        warnings.push("Open Congress documents response is not in expected format.");
        break;
      }

      const documents = payload.data;

      if (!documents.length) {
        if (offset > 0 && !resetAttempted) {
          offset = 0;
          resetAttempted = true;
          continue;
        }

        offset = 0;
        break;
      }

      let addedThisPage = 0;

      for (const document of documents) {
        const { record, dedupeKey } = buildRecord(document);
        const resolvedKey = dedupeKey || record.id;

        if (seen.has(resolvedKey)) {
          continue;
        }

        seen.add(resolvedKey);
        records.push(record);
        addedThisPage += 1;

        if (records.length >= MAX_RECORDS_PER_RUN) {
          break;
        }
      }

      pagesFetched += 1;
      offset += documents.length;

      if (documents.length < pageSize) {
        offset = 0;
        break;
      }

      if (!addedThisPage) {
        warnings.push("Open Congress pagination returned duplicate-only page; stopping early.");
        offset = 0;
        break;
      }
    }

    try {
      await patchScrapeCheckpoint({ openCongressOffset: offset });
    } catch (error) {
      warnings.push(
        `Unable to persist open congress checkpoint: ${error instanceof Error ? error.message : "Unknown checkpoint error"}`,
      );
    }

    if (!records.length) {
      warnings.push("No Open Congress documents parsed for this run.");
    }

    return {
      source: "open_congress",
      records,
      warnings,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Unknown scrape error");

    return {
      source: "open_congress",
      records: [],
      warnings,
    };
  }
}

async function runStandalone() {
  const result = await scrapeOpenCongress();
  const outputPath = path.resolve(process.cwd(), "data", "open-congress.records.json");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result.records, null, 2), "utf8");

  console.log(`Open Congress records: ${result.records.length}`);

  if (result.warnings.length) {
    console.log(`Warnings: ${result.warnings.join(" | ")}`);
  }
}

if (process.argv.includes("--run")) {
  runStandalone().catch((error) => {
    console.error("Open Congress scrape failed:", error);
    process.exitCode = 1;
  });
}
