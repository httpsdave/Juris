import seedRecords from "@/data/laws.sample.json";
import scrapedRecords from "@/data/laws.scraped.json";
import { sourceProfiles } from "@/lib/source-registry";
import type {
  LawCategory,
  LawRecord,
  LawSearchQuery,
  LawSearchResult,
  LawSourceId,
} from "@/types/law";

const records = [...((scrapedRecords as LawRecord[]) ?? []), ...((seedRecords as LawRecord[]) ?? [])];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const QUERY_EXPANSION: Record<string, string[]> = {
  cyber: ["cybercrime", "computer", "electronic"],
  cybercrime: ["cyber", "computer", "electronic"],
  gambling: ["gaming", "betting", "wager", "wagering", "pogo"],
  gaming: ["gambling", "betting", "wager", "wagering", "pogo"],
  online: ["internet", "electronic", "digital", "web"],
};

interface SearchSignal {
  score: number;
  phraseMatch: boolean;
  primaryMatches: number;
  expandedMatches: number;
}

function normalizeForSearch(input?: string): string {
  if (!input) {
    return "";
  }

  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input?: string): string[] {
  const normalized = normalizeForSearch(input);

  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .filter((part) => !STOP_WORDS.has(part));

  return Array.from(new Set(tokens));
}

function expandQueryTokens(tokens: string[]): string[] {
  const expanded = new Set<string>();

  for (const token of tokens) {
    for (const synonym of QUERY_EXPANSION[token] ?? []) {
      expanded.add(synonym);
    }
  }

  return Array.from(expanded);
}

function buildSearchFields(record: LawRecord) {
  const title = normalizeForSearch(record.title);
  const shortTitle = normalizeForSearch(record.shortTitle);
  const lawNumber = normalizeForSearch(record.lawNumber);
  const summary = normalizeForSearch(record.summary);
  const tags = normalizeForSearch(record.tags.join(" "));
  const preview = normalizeForSearch(record.fullTextPreview);
  const fullText = normalizeForSearch(record.fullText);

  const all = [title, shortTitle, lawNumber, summary, tags, preview, fullText].filter(Boolean).join(" ");

  return {
    title,
    shortTitle,
    lawNumber,
    summary,
    tags,
    preview,
    fullText,
    all,
  };
}

function scoreRecord(record: LawRecord, normalizedQuery: string, tokens: string[], expandedTokens: string[]): SearchSignal {
  const fields = buildSearchFields(record);

  const phraseMatch = normalizedQuery.length > 2 && fields.all.includes(normalizedQuery);
  const titlePhraseMatch = phraseMatch && fields.title.includes(normalizedQuery);

  const primaryMatches = tokens.filter((token) => fields.all.includes(token)).length;
  const expandedMatches = expandedTokens.filter((token) => fields.all.includes(token)).length;

  const titleTokenMatches = tokens.filter(
    (token) => fields.title.includes(token) || fields.shortTitle.includes(token),
  ).length;
  const lawNumberMatches = tokens.filter((token) => fields.lawNumber.includes(token)).length;
  const summaryMatches = tokens.filter((token) => fields.summary.includes(token)).length;
  const tagMatches = tokens.filter((token) => fields.tags.includes(token)).length;
  const fullTextMatches = tokens.filter(
    (token) => fields.preview.includes(token) || fields.fullText.includes(token),
  ).length;

  const sourceScore = sourceProfiles[record.source]?.reliabilityScore ?? 0;
  const freshnessScore =
    record.freshness === "fresh"
      ? 8
      : record.freshness === "api"
        ? 6
        : record.freshness === "stale"
          ? 2
          : -10;

  let score = record.authorityLevel + sourceScore * 0.25 + freshnessScore;

  score += titleTokenMatches * 24;
  score += lawNumberMatches * 18;
  score += summaryMatches * 14;
  score += tagMatches * 12;
  score += fullTextMatches * 8;
  score += expandedMatches * 4;

  if (phraseMatch) {
    score += titlePhraseMatch ? 48 : 28;
  }

  if (tokens.length > 1 && primaryMatches === tokens.length) {
    score += 18;
  }

  if (record.fullText) {
    score += 2;
  }

  return {
    score,
    phraseMatch,
    primaryMatches,
    expandedMatches,
  };
}

function sortByDate(a?: string, b?: string): number {
  if (!a && !b) {
    return 0;
  }

  if (!a) {
    return 1;
  }

  if (!b) {
    return -1;
  }

  return new Date(b).getTime() - new Date(a).getTime();
}

function isNoisyReaderText(text?: string): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  const earlyWindow = normalized.slice(0, 2600);
  const hasOgHeaderNoise = earlyWindow.includes("about official gazette");
  const trailingNoise =
    /(feedback form|privacy policy|frequently asked questions|government links|managed by ict division|all content is in the public domain unless otherwise stated)/i.test(
      normalized,
    );

  return hasOgHeaderNoise && trailingNoise;
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

function dedupeLaws(laws: LawRecord[]): LawRecord[] {
  const byKey = new Map<string, LawRecord>();

  for (const law of laws) {
    const dedupeKey = `${law.lawNumber ?? law.title}:${law.source}`.toLowerCase();

    if (!byKey.has(dedupeKey)) {
      byKey.set(dedupeKey, law);
      continue;
    }

    const existing = byKey.get(dedupeKey);

    if (!existing) {
      byKey.set(dedupeKey, law);
      continue;
    }

    const existingQuality =
      existing.authorityLevel +
      (existing.freshness === "fresh" || existing.freshness === "api" ? 3 : 0) +
      (existing.fullText && !isNoisyReaderText(existing.fullText) ? 2 : 0);
    const currentQuality =
      law.authorityLevel +
      (law.freshness === "fresh" || law.freshness === "api" ? 3 : 0) +
      (law.fullText && !isNoisyReaderText(law.fullText) ? 2 : 0);

    const preferred = currentQuality > existingQuality ? law : existing;
    const secondary = preferred === law ? existing : law;
    byKey.set(dedupeKey, mergeRecords(preferred, secondary));
  }

  return Array.from(byKey.values());
}

export function getAllLaws(): LawRecord[] {
  return dedupeLaws(records);
}

export function getLawById(id: string): LawRecord | undefined {
  return getAllLaws().find((record) => record.id === id);
}

export function searchLaws(query: LawSearchQuery): LawSearchResult {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const source = query.source && query.source !== "all" ? query.source : undefined;
  const category = query.category && query.category !== "all" ? query.category : undefined;
  const broadMode = query.broad === true;
  const normalizedQuery = normalizeForSearch(query.q);
  const tokens = tokenize(query.q);
  const expandedTokens = expandQueryTokens(tokens);
  const laws = getAllLaws();
  const directMatchThreshold = tokens.length <= 1 ? 1 : Math.max(1, Math.ceil(tokens.length * 0.6));

  const allowSingleTokenExpansion =
    broadMode &&
    tokens.length === 1 &&
    Boolean(normalizedQuery) &&
    !laws.some((record) => {
      const signal = scoreRecord(record, normalizedQuery, tokens, expandedTokens);
      return signal.phraseMatch || signal.primaryMatches >= directMatchThreshold;
    });

  const ranked = laws
    .filter((record) => {
      if (source && record.source !== source) {
        return false;
      }

      if (category && record.category !== category) {
        return false;
      }

      if (!tokens.length && !normalizedQuery) {
        return true;
      }

      const signal = scoreRecord(record, normalizedQuery, tokens, expandedTokens);
      if (signal.phraseMatch || signal.primaryMatches >= directMatchThreshold) {
        return true;
      }

      if (!broadMode) {
        return false;
      }

      if (tokens.length <= 1) {
        return allowSingleTokenExpansion && signal.expandedMatches > 0;
      }

      return signal.expandedMatches >= Math.max(2, Math.ceil(tokens.length * 0.6));
    })
    .map((record) => ({
      record,
      signal: scoreRecord(record, normalizedQuery, tokens, expandedTokens),
    }))
    .sort((a, b) => {
      if (b.signal.score === a.signal.score) {
        return sortByDate(a.record.enactedOn, b.record.enactedOn);
      }

      return b.signal.score - a.signal.score;
    })
    .map((entry) => entry.record);

  const items = ranked.slice(offset, offset + limit);

  return {
    items,
    total: ranked.length,
    limit,
    offset,
    query,
  };
}

export function getSourceCoverage() {
  const laws = getAllLaws();
  const bySource = new Map<LawSourceId, number>();

  for (const law of laws) {
    bySource.set(law.source, (bySource.get(law.source) ?? 0) + 1);
  }

  return Object.values(sourceProfiles).map((profile) => ({
    ...profile,
    indexedCount: bySource.get(profile.id) ?? 0,
  }));
}

export function getCategoryOptions(): Array<{ label: string; value: LawCategory | "all" }> {
  const allCategories = new Set<LawCategory>();

  for (const law of getAllLaws()) {
    allCategories.add(law.category);
  }

  const options = Array.from(allCategories)
    .sort()
    .map((category) => ({
      label: category.replaceAll("_", " "),
      value: category,
    }));

  return [{ label: "all categories", value: "all" }, ...options];
}
