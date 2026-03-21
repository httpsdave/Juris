import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LawRecord } from "../../types/law";

import { scrapeChanrobles } from "./chanrobles";
import { scrapeCongressPortal } from "./congress";
import { scrapeJudiciaryElibrary } from "./judiciary-elibrary";
import { scrapeLawphil } from "./lawphil";
import { scrapeOfficialGazette } from "./official-gazette";
import { scrapeOpenCongress } from "./open-congress";
import type { ScrapeResult } from "./shared";

function toTimestamp(input?: string): number {
  if (!input) {
    return 0;
  }

  const timestamp = new Date(input).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isNoisyReaderText(text?: string): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  const earlyWindow = normalized.slice(0, 2600);
  const hasOgHeaderNoise = earlyWindow.includes("about official gazette");
  const hasChanroblesHeaderNoise =
    earlyWindow.includes("chanrobles virtual law library") ||
    earlyWindow.includes("search for www.chanrobles.com") ||
    earlyWindow.includes("please click here for the latest");
  const trailingNoise =
    /(feedback form|privacy policy|frequently asked questions|government links|managed by ict division|all content is in the public domain unless otherwise stated)/i.test(
      normalized,
    );

  return (hasOgHeaderNoise && trailingNoise) || hasChanroblesHeaderNoise;
}

function pickBestText(...candidates: Array<string | undefined>): string | undefined {
  const usable = candidates
    .map((entry) => (entry ? entry.trim() : ""))
    .filter((entry) => entry.length > 0 && !isNoisyReaderText(entry));

  if (!usable.length) {
    return undefined;
  }

  return usable.sort((left, right) => right.length - left.length)[0];
}

function qualityScore(record: LawRecord): number {
  const freshnessBoost = record.freshness === "fresh" ? 10 : record.freshness === "api" ? 7 : record.freshness === "stale" ? 2 : -8;
  const textBoost = record.fullText && !isNoisyReaderText(record.fullText) ? 8 : record.fullTextPreview ? 3 : 0;
  const summaryBoost = Math.min(8, Math.floor(record.summary.length / 70));

  return record.authorityLevel + freshnessBoost + textBoost + summaryBoost;
}

function shouldReplaceRecord(current: LawRecord, candidate: LawRecord): boolean {
  const candidateQuality = qualityScore(candidate);
  const currentQuality = qualityScore(current);

  if (candidateQuality !== currentQuality) {
    return candidateQuality > currentQuality;
  }

  return toTimestamp(candidate.lastVerifiedAt) >= toTimestamp(current.lastVerifiedAt);
}

function mergeRecords(preferred: LawRecord, secondary: LawRecord): LawRecord {
  const mergedFullText = pickBestText(preferred.fullText, secondary.fullText);
  const mergedPreview = pickBestText(
    preferred.fullTextPreview,
    secondary.fullTextPreview,
    mergedFullText,
  );

  return {
    ...secondary,
    ...preferred,
    summary: preferred.summary || secondary.summary,
    fullText: mergedFullText,
    fullTextPreview: mergedPreview,
    sourcePdfUrl: preferred.sourcePdfUrl ?? secondary.sourcePdfUrl,
    relatedDocumentIds: preferred.relatedDocumentIds ?? secondary.relatedDocumentIds,
    tags: Array.from(new Set([...(secondary.tags ?? []), ...(preferred.tags ?? [])])),
  };
}

function extractCongressNumber(record: LawRecord): string | undefined {
  const fromTitle = record.title.match(/\(congress\s+(\d+)\)/i)?.[1];

  if (fromTitle) {
    return fromTitle;
  }

  const related = record.relatedDocumentIds ?? [];

  for (const value of related) {
    const matched = value.match(/^[a-z]+-(\d+)-\d+$/i)?.[1];

    if (matched) {
      return matched;
    }
  }

  return undefined;
}

function buildDedupeKey(record: LawRecord): string {
  const identity = (record.lawNumber ?? record.title).trim().toLowerCase();

  if (record.source !== "congress") {
    return `${record.source}:${identity}`;
  }

  const congress = extractCongressNumber(record);
  return `${record.source}:${identity}:${congress ?? "unknown"}`;
}

function dedupe(records: LawRecord[]): LawRecord[] {
  const byKey = new Map<string, LawRecord>();

  for (const record of records) {
    const key = buildDedupeKey(record);

    if (!byKey.has(key)) {
      byKey.set(key, record);
      continue;
    }

    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, record);
      continue;
    }

    const preferred = shouldReplaceRecord(existing, record) ? record : existing;
    const secondary = preferred === record ? existing : record;
    byKey.set(key, mergeRecords(preferred, secondary));
  }

  return Array.from(byKey.values());
}

function isLegacyChanroblesTopicRecord(record: LawRecord): boolean {
  if (record.source !== "chanrobles") {
    return false;
  }

  const hasLegacyTag = record.tags.some((tag) => tag.trim().toLowerCase() === "topic index");

  if (hasLegacyTag) {
    return true;
  }

  return /^topic index entry from chanrobles virtual law library:/i.test(record.summary);
}

async function readExistingRecords(filePath: string): Promise<LawRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as LawRecord[];
  } catch {
    return [];
  }
}

async function run() {
  const startedAt = new Date();

  const results: ScrapeResult[] = [];
  results.push(await scrapeOfficialGazette());
  results.push(await scrapeJudiciaryElibrary());
  results.push(await scrapeLawphil());
  results.push(await scrapeChanrobles());
  results.push(await scrapeCongressPortal());
  results.push(await scrapeOpenCongress());

  const runRecords = dedupe(results.flatMap((result) => result.records));

  const dataDir = path.resolve(process.cwd(), "data");
  await mkdir(dataDir, { recursive: true });

  const outputPath = path.join(dataDir, "laws.scraped.json");
  const previousRecords = await readExistingRecords(outputPath);
  const allRecords = dedupe([...runRecords, ...previousRecords]).filter(
    (record) => !isLegacyChanroblesTopicRecord(record),
  );

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    previousRecords: previousRecords.length,
    runRecords: runRecords.length,
    sources: results.map((result) => ({
      source: result.source,
      count: result.records.length,
      warnings: result.warnings,
    })),
    totalRecords: allRecords.length,
  };

  await writeFile(outputPath, JSON.stringify(allRecords, null, 2), "utf8");
  await writeFile(path.join(dataDir, "scrape-report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(
    `Scraped ${runRecords.length} records this run. Dataset is now ${allRecords.length} records (previously ${previousRecords.length}).`,
  );

  for (const source of report.sources) {
    const warningText = source.warnings.length ? ` (warnings: ${source.warnings.length})` : "";
    console.log(`- ${source.source}: ${source.count}${warningText}`);
  }
}

run().catch((error) => {
  console.error("Scrape pipeline failed:", error);
  process.exitCode = 1;
});
