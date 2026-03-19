export type LawSourceId =
  | "lawphil"
  | "official_gazette"
  | "chanrobles"
  | "congress"
  | "judiciary_elibrary"
  | "open_congress";

export type SourceMode = "api" | "scrape" | "hybrid";

export type LawCategory =
  | "constitution"
  | "republic_act"
  | "executive_issuance"
  | "jurisprudence"
  | "bill"
  | "code"
  | "rule"
  | "ordinance"
  | "other";

export type FreshnessStatus = "fresh" | "stale" | "blocked" | "api";

export interface LawRecord {
  id: string;
  title: string;
  shortTitle?: string;
  lawNumber?: string;
  category: LawCategory;
  summary: string;
  enactedOn?: string;
  source: LawSourceId;
  sourceUrl: string;
  sourcePdfUrl?: string;
  tags: string[];
  fullTextPreview?: string;
  fullText?: string;
  isPrimarySource: boolean;
  freshness: FreshnessStatus;
  lastVerifiedAt: string;
  authorityLevel: number;
  relatedDocumentIds?: string[];
}

export interface SourceProfile {
  id: LawSourceId;
  name: string;
  mode: SourceMode;
  baseUrl: string;
  isOfficial: boolean;
  reliabilityScore: number;
  accessNotes: string;
  updateNotes: string;
}

export interface LawSearchQuery {
  q?: string;
  source?: LawSourceId | "all";
  category?: LawCategory | "all";
  broad?: boolean;
  limit?: number;
  offset?: number;
}

export interface LawSearchResult {
  items: LawRecord[];
  total: number;
  limit: number;
  offset: number;
  query: LawSearchQuery;
}
