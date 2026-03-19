"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  BookMarked,
  Clock3,
  Database,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

import type {
  FreshnessStatus,
  LawCategory,
  LawRecord,
  LawSourceId,
  SourceHealthMetrics,
  SourceProfile,
} from "@/types/law";

interface JurisExplorerProps {
  sourceOptions: Array<{ label: string; value: LawSourceId | "all" }>;
  categoryOptions: Array<{ label: string; value: LawCategory | "all" }>;
  sourceCoverage: Array<SourceProfile & SourceHealthMetrics>;
}

interface LawApiResponse {
  success: boolean;
  data: LawRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

interface OpenCongressStatsResponse {
  success: boolean;
  data?: {
    totalBills: number;
    totalHouseBills: number;
    totalSenateBills: number;
    totalCongresses: number;
    totalPeople: number;
    totalCommittees: number;
  };
}

const BOOKMARK_KEY = "juris.bookmarks.v1";
const READ_LATER_KEY = "juris.readLater.v1";
const EXPLORER_SCROLL_KEY = "juris.explorer.scroll.v1";
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with"]);

interface ScrollRestoreState {
  path: string;
  scrollY: number;
  savedAt: string;
}

function normalizeLabel(input: string): string {
  return input
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildSearchTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const terms = normalized
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .filter((part) => !SEARCH_STOP_WORDS.has(part));

  return Array.from(new Set(terms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightRegex(terms: string[]): RegExp | null {
  if (!terms.length) {
    return null;
  }

  const pattern = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((term) => escapeRegExp(term))
    .join("|");

  if (!pattern) {
    return null;
  }

  return new RegExp(`(${pattern})`, "gi");
}

function renderHighlightedText(text: string, terms: string[]): React.ReactNode {
  const regex = buildHighlightRegex(terms);

  if (!regex) {
    return text;
  }

  const parts = text.split(regex);

  return parts.map((part, index) => {
    const isMatch = terms.some((term) => term.toLowerCase() === part.toLowerCase());

    if (!isMatch) {
      return <span key={`txt-${index}`}>{part}</span>;
    }

    return (
      <mark
        key={`m-${index}`}
        className="bg-[var(--color-accent)] px-1 text-[var(--color-surface-0)]"
      >
        {part}
      </mark>
    );
  });
}

function buildMatchExcerpt(text: string | undefined, terms: string[], radius = 160): string | undefined {
  if (!text || !terms.length) {
    return undefined;
  }

  const regex = buildHighlightRegex(terms);

  if (!regex) {
    return undefined;
  }

  const found = regex.exec(text);

  if (!found || found.index < 0) {
    return undefined;
  }

  const start = Math.max(0, found.index - radius);
  const end = Math.min(text.length, found.index + found[0].length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function freshnessTone(status: FreshnessStatus) {
  if (status === "fresh") {
    return "bg-[var(--color-surface-1)] text-[#097969] border border-[#097969] brutal-shadow";
  }

  if (status === "api") {
    return "bg-[var(--color-surface-1)] text-[#005A9C] border border-[#005A9C] brutal-shadow";
  }

  if (status === "blocked") {
    return "bg-[var(--color-surface-1)] text-[#E46C0A] border border-[#E46C0A] brutal-shadow";
  }

  return "bg-[var(--color-surface-1)] text-[var(--color-fg-primary)] border border-[var(--color-fg-primary)] brutal-shadow";
}

function freshnessLabel(status: FreshnessStatus): string {
  if (status === "fresh") {
    return "recently verified";
  }

  if (status === "api") {
    return "live api feed";
  }

  if (status === "blocked") {
    return "source currently blocked";
  }

  return "needs recheck";
}

function freshnessDescription(status: FreshnessStatus): string {
  if (status === "fresh") {
    return "Recently validated by scraper checks.";
  }

  if (status === "api") {
    return "Pulled from an API source in the latest ingestion run.";
  }

  if (status === "blocked") {
    return "Source endpoint was inaccessible during scraping.";
  }

  return "Record exists but source verification is older and should be refreshed.";
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function loadIdSet(key: string): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const raw = window.localStorage.getItem(key);

    if (!raw) {
      return new Set();
    }

    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function persistIdSet(key: string, values: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(Array.from(values)));
}

export function JurisExplorer({
  sourceOptions,
  categoryOptions,
  sourceCoverage,
}: JurisExplorerProps) {
  const [query, setQuery] = useState("");
  const [broadMode, setBroadMode] = useState(false);
  const [selectedSources, setSelectedSources] = useState<LawSourceId[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<LawCategory[]>([]);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [filtersReady, setFiltersReady] = useState(false);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [laws, setLaws] = useState<LawRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [readLater, setReadLater] = useState<Set<string>>(new Set());
  const [openCongressStats, setOpenCongressStats] = useState<OpenCongressStatsResponse["data"]>();
  const initialFilterHydrationRef = useRef(false);
  const hasRestoredScrollRef = useRef(false);
  const sourceMenuRef = useRef<HTMLDivElement | null>(null);
  const categoryMenuRef = useRef<HTMLDivElement | null>(null);
  const sourceFilterOptions = useMemo(
    () =>
      sourceOptions.filter(
        (option): option is { label: string; value: LawSourceId } => option.value !== "all",
      ),
    [sourceOptions],
  );
  const categoryFilterOptions = useMemo(
    () =>
      categoryOptions.filter(
        (option): option is { label: string; value: LawCategory } => option.value !== "all",
      ),
    [categoryOptions],
  );
  const sourceValues = useMemo(
    () => new Set(sourceFilterOptions.map((option) => option.value)),
    [sourceFilterOptions],
  );
  const categoryValues = useMemo(
    () => new Set(categoryFilterOptions.map((option) => option.value)),
    [categoryFilterOptions],
  );
  const searchTerms = useMemo(() => buildSearchTerms(query), [query]);
  const sourceSummaryLabel = useMemo(() => {
    if (!selectedSources.length) {
      return "All sources";
    }

    if (selectedSources.length === 1) {
      return normalizeLabel(selectedSources[0]);
    }

    return `${selectedSources.length} sources selected`;
  }, [selectedSources]);
  const categorySummaryLabel = useMemo(() => {
    if (!selectedCategories.length) {
      return "All classifications";
    }

    if (selectedCategories.length === 1) {
      return normalizeLabel(selectedCategories[0]);
    }

    return `${selectedCategories.length} classifications selected`;
  }, [selectedCategories]);
  const backHref = useMemo(() => {
    const params = new URLSearchParams();

    if (query.trim()) {
      params.set("q", query.trim());
    }

    selectedSources.forEach((sourceId) => {
      params.append("source", sourceId);
    });

    selectedCategories.forEach((categoryId) => {
      params.append("category", categoryId);
    });

    if (broadMode) {
      params.set("broad", "true");
    }

    const search = params.toString();
    return search ? `/?${search}` : "/";
  }, [broadMode, query, selectedCategories, selectedSources]);

  useEffect(() => {
    setBookmarks(loadIdSet(BOOKMARK_KEY));
    setReadLater(loadIdSet(READ_LATER_KEY));
  }, []);

  useEffect(() => {
    if (initialFilterHydrationRef.current || typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const queryFromUrl = params.get("q") ?? "";
    const broadFromUrl = params.get("broad");
    const sourceFromUrl = params
      .getAll("source")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value): value is LawSourceId => sourceValues.has(value as LawSourceId));
    const categoryFromUrl = params
      .getAll("category")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value): value is LawCategory => categoryValues.has(value as LawCategory));

    initialFilterHydrationRef.current = true;
    setQuery(queryFromUrl);
    setBroadMode(broadFromUrl === "true" || broadFromUrl === "1");
    setSelectedSources(Array.from(new Set(sourceFromUrl)));
    setSelectedCategories(Array.from(new Set(categoryFromUrl)));
    setFiltersReady(true);
  }, [categoryValues, sourceValues]);

  useEffect(() => {
    if (!filtersReady || typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams();

    if (query.trim()) {
      params.set("q", query.trim());
    }

    selectedSources.forEach((sourceId) => {
      params.append("source", sourceId);
    });

    selectedCategories.forEach((categoryId) => {
      params.append("category", categoryId);
    });

    if (broadMode) {
      params.set("broad", "true");
    }

    const search = params.toString();
    const nextUrl = search ? `/?${search}` : "/";
    const currentUrl = `${window.location.pathname}${window.location.search}`;

    if (currentUrl !== nextUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [broadMode, filtersReady, query, selectedCategories, selectedSources]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (sourceMenuRef.current && !sourceMenuRef.current.contains(target)) {
        setSourceMenuOpen(false);
      }

      if (categoryMenuRef.current && !categoryMenuRef.current.contains(target)) {
        setCategoryMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentClick);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
    };
  }, []);

  useEffect(() => {
    if (!filtersReady || !hasFetchedOnce || hasRestoredScrollRef.current || typeof window === "undefined") {
      return;
    }

    hasRestoredScrollRef.current = true;

    try {
      const raw = window.sessionStorage.getItem(EXPLORER_SCROLL_KEY);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as ScrollRestoreState;
      const currentPath = `${window.location.pathname}${window.location.search}`;

      if (parsed.path !== currentPath) {
        return;
      }

      window.requestAnimationFrame(() => {
        window.scrollTo({ top: Math.max(0, parsed.scrollY), behavior: "auto" });
      });
    } catch {
      // Ignore malformed restoration payloads.
    }
  }, [filtersReady, hasFetchedOnce]);

  useEffect(() => {
    if (!filtersReady) {
      return;
    }

    const controller = new AbortController();

    const timeout = setTimeout(async () => {
      setLoading(true);
      setError(null);

      try {
        const url = new URL("/api/laws", window.location.origin);

        if (query.trim()) {
          url.searchParams.set("q", query.trim());
        }

        selectedSources.forEach((sourceId) => {
          url.searchParams.append("source", sourceId);
        });

        selectedCategories.forEach((categoryId) => {
          url.searchParams.append("category", categoryId);
        });

        url.searchParams.set("broad", broadMode ? "true" : "false");

        url.searchParams.set("limit", "30");
        url.searchParams.set("offset", "0");

        const response = await fetch(url.toString(), {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Search request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as LawApiResponse;

        if (!payload.success) {
          throw new Error("Search endpoint returned an unsuccessful response");
        }

        setLaws(payload.data);
        setTotal(payload.pagination.total);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }

        setError(err instanceof Error ? err.message : "Unable to fetch laws right now.");
      } finally {
        setLoading(false);
        setHasFetchedOnce(true);
      }
    }, 180);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [broadMode, filtersReady, query, selectedCategories, selectedSources]);

  useEffect(() => {
    let active = true;

    const loadStats = async () => {
      try {
        const response = await fetch("/api/open-congress/stats", {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as OpenCongressStatsResponse;

        if (active && payload.success && payload.data) {
          setOpenCongressStats(payload.data);
        }
      } catch {
        // Non-blocking; local search still works without this widget.
      }
    };

    loadStats();

    return () => {
      active = false;
    };
  }, []);

  const lawMap = useMemo(() => {
    return new Map(laws.map((law) => [law.id, law]));
  }, [laws]);

  const bookmarkedLaws = useMemo(() => {
    return Array.from(bookmarks)
      .map((id) => lawMap.get(id))
      .filter((entry): entry is LawRecord => Boolean(entry));
  }, [bookmarks, lawMap]);

  const readLaterLaws = useMemo(() => {
    return Array.from(readLater)
      .map((id) => lawMap.get(id))
      .filter((entry): entry is LawRecord => Boolean(entry));
  }, [readLater, lawMap]);

  const toggleBookmark = (lawId: string) => {
    setBookmarks((current) => {
      const next = new Set(current);

      if (next.has(lawId)) {
        next.delete(lawId);
      } else {
        next.add(lawId);
      }

      persistIdSet(BOOKMARK_KEY, next);
      return next;
    });
  };

  const toggleReadLater = (lawId: string) => {
    setReadLater((current) => {
      const next = new Set(current);

      if (next.has(lawId)) {
        next.delete(lawId);
      } else {
        next.add(lawId);
      }

      persistIdSet(READ_LATER_KEY, next);
      return next;
    });
  };

  const toggleSourceFilter = (sourceId: LawSourceId) => {
    setSelectedSources((current) => {
      if (current.includes(sourceId)) {
        return current.filter((entry) => entry !== sourceId);
      }

      return [...current, sourceId];
    });
  };

  const toggleCategoryFilter = (categoryId: LawCategory) => {
    setSelectedCategories((current) => {
      if (current.includes(categoryId)) {
        return current.filter((entry) => entry !== categoryId);
      }

      return [...current, categoryId];
    });
  };

  const selectAllSources = () => {
    setSelectedSources(sourceFilterOptions.map((option) => option.value));
  };

  const clearSources = () => {
    setSelectedSources([]);
  };

  const selectAllCategories = () => {
    setSelectedCategories(categoryFilterOptions.map((option) => option.value));
  };

  const clearCategories = () => {
    setSelectedCategories([]);
  };

  const rememberExplorerScroll = () => {
    if (typeof window === "undefined") {
      return;
    }

    const snapshot: ScrollRestoreState = {
      path: backHref,
      scrollY: window.scrollY,
      savedAt: new Date().toISOString(),
    };

    window.sessionStorage.setItem(EXPLORER_SCROLL_KEY, JSON.stringify(snapshot));
  };

  return (
    <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 pb-16 pt-8 sm:px-8">
      {/* Editorial Hero */}
      <section className="animate-slide-up-cascade bg-[var(--color-surface-inv)] text-[var(--color-fg-primary-inv)] brutal-shadow border-2 border-[var(--color-surface-inv)]">
        <div className="flex flex-col md:flex-row">
          <div className="p-8 md:p-12 w-full md:w-2/3 border-b-2 md:border-b-0 md:border-r-2 border-[#333333] space-y-6">
            <p className="inline-flex items-center gap-2 font-mono text-sm tracking-widest text-[var(--color-accent)] font-bold uppercase">
              <Scale className="h-5 w-5" aria-hidden="true" />
              Philippine Legal Database
            </p>
            <h1 className="text-4xl sm:text-6xl lg:text-[4.5rem]">
              Knowledge is structured. <br/> Access is power.
            </h1>
            <p className="max-w-xl text-lg font-mono leading-relaxed opacity-90">
              Juris aggregates official publications, judiciary listings, and API-backed legislative metadata into an uncompromising, searchable public record.
            </p>
          </div>
          <div className="w-full md:w-1/3 bg-[var(--color-accent)] text-[var(--color-surface-0)] p-8 md:p-12 flex flex-col justify-between">
            <div>
              <h2 className="mb-6 inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest border-b border-black/20 pb-2 w-full">
                <Database className="h-4 w-4" aria-hidden="true" />
                Archive Overview
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <Metric label="Indexed" value={String(total)} inverted />
                <Metric label="Sources" value={String(sourceCoverage.filter((entry) => entry.indexedCount > 0).length)} inverted />
                <Metric label="Saved" value={String(bookmarks.size)} inverted />
                <Metric label="Queue" value={String(readLater.size)} inverted />
              </div>
            </div>
            {openCongressStats ? (
              <div className="mt-8 border-t-2 border-[var(--color-surface-0)] pt-4 font-mono text-xs opacity-90 leading-relaxed uppercase">
                <span className="font-bold underline underline-offset-2">Query Stats:</span> Open Congress reports <br/>
                <span className="text-xl">
                  {openCongressStats.totalBills.toLocaleString()}
                </span> Bills / 
                <span className="text-xl">
                  {" "}{openCongressStats.totalPeople.toLocaleString()}
                </span> Reps.
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* Controller / Search Bar */}
      <section className="animate-slide-up-cascade grid grid-cols-2 gap-4 bg-[var(--color-surface-0)] border-y-2 border-[var(--color-fg-primary)] py-6 md:grid-cols-[1fr_240px_240px] items-end px-2">
        <label className="group relative block w-full col-span-2 md:col-span-1">
          <span className="mb-2 block font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
            Primary Query
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--color-fg-primary)]" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search explicitly by title or keyword..."
              className="h-14 w-full border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] pl-12 pr-4 font-mono text-sm text-[var(--color-fg-primary)] outline-none placeholder:text-[var(--color-fg-muted)] focus:brutal-shadow focus:bg-[var(--color-surface-0)] transition-all"
            />
          </div>
        </label>

        <div className={`block w-full relative ${sourceMenuOpen ? "z-50" : "z-10"}`} ref={sourceMenuRef}>
          <span className="mb-2 block font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
            Source
          </span>
          <MultiSelectDropdown
            buttonLabel={sourceSummaryLabel}
            isOpen={sourceMenuOpen}
            onToggle={() => setSourceMenuOpen((current) => !current)}
            options={sourceFilterOptions.map((option) => ({
              label: option.label,
              value: option.value,
            }))}
            selectedValues={new Set(selectedSources)}
            onToggleValue={(value) => toggleSourceFilter(value as LawSourceId)}
            onClear={clearSources}
            onSelectAll={selectAllSources}
            emptyHint="All sources included"
          />
        </div>

        <div className={`block w-full relative ${categoryMenuOpen ? "z-50" : "z-10"}`} ref={categoryMenuRef}>
          <span className="mb-2 block font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
            Classification
          </span>
          <MultiSelectDropdown
            buttonLabel={categorySummaryLabel}
            isOpen={categoryMenuOpen}
            onToggle={() => setCategoryMenuOpen((current) => !current)}
            options={categoryFilterOptions.map((option) => ({
              label: normalizeLabel(option.label),
              value: option.value,
            }))}
            selectedValues={new Set(selectedCategories)}
            onToggleValue={(value) => toggleCategoryFilter(value as LawCategory)}
            onClear={clearCategories}
            onSelectAll={selectAllCategories}
            emptyHint="All classifications included"
          />
        </div>

        <div className="col-span-2 md:col-span-3 flex flex-col gap-2 border-l-4 border-[var(--color-accent)] bg-[var(--color-surface-1)] px-4 py-3">
          <label className="inline-flex cursor-pointer items-center gap-3 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-primary)]">
            <input
              type="checkbox"
              checked={broadMode}
              onChange={(event) => setBroadMode(event.target.checked)}
              className="h-4 w-4 border-2 border-[var(--color-fg-primary)] accent-[var(--color-accent)]"
            />
            Enable Broad Matches (Synonyms + Related Terms)
          </label>
          <p className="font-mono text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
            Strict mode hides weak synonym-only hits. Turn broad mode on when exploring related concepts.
          </p>
        </div>
      </section>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:justify-between font-mono text-xs font-bold uppercase text-[var(--color-fg-muted)]">
        <p className="bg-[var(--color-fg-primary)] text-[var(--color-surface-0)] px-3 py-1 brutal-shadow self-start">
          {loading ? "Scanning Archives..." : `${total.toLocaleString()} Articles Indexed`} {broadMode ? "(Broad)" : "(Strict)"}
        </p>
        <Link href="/about" className="group flex items-center gap-2 text-[var(--color-accent)] hover:underline decoration-2 underline-offset-4 self-start sm:self-auto">
          Documentation & Methodology
          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" aria-hidden="true" />
        </Link>
      </div>

      <p className="font-mono text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)] border-l-4 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] px-3 py-2">
        Status Guide: Recently Verified, Live API Feed, Needs Recheck, or Source Currently Blocked.
      </p>

      <section className="grid gap-12 lg:grid-cols-[1fr_320px]">
        {/* Results Container */}
        <div className="space-y-6 min-w-0">
          {error ? (
            <div className="border-2 border-[#E23126] bg-[#FFB8B3] p-6 font-mono text-sm text-[#E23126] brutal-shadow dark:text-red-900">
              SYSTEM ERROR: {error}
            </div>
          ) : null}

          {!error && !laws.length && !loading ? (
            <div className="border-2 border-dashed border-[var(--color-fg-muted)] bg-[var(--color-surface-1)] p-16 text-center font-mono text-sm text-[var(--color-fg-muted)]">
              NO MATCHING LAWS YET. TRY A DIFFERENT KEYWORD OR ENABLE BROAD MODE FOR RELATED TERMS.
            </div>
          ) : null}

          <AnimatePresence>
            {laws.map((law, index) => {
              const isBookmarked = bookmarks.has(law.id);
              const isReadLater = readLater.has(law.id);
              const matchExcerpt = buildMatchExcerpt(law.fullText ?? law.fullTextPreview, searchTerms, 170);
              const excerptText =
                matchExcerpt ??
                (law.fullTextPreview && law.fullTextPreview !== law.summary
                  ? law.fullTextPreview.slice(0, 320)
                  : undefined);
              const readerParams = new URLSearchParams();

              if (query.trim()) {
                readerParams.set("q", query.trim());
              }

              readerParams.set("back", backHref);
              const readerHref = `/laws/${law.id}?${readerParams.toString()}`;

              return (
                <motion.article
                  key={law.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.5) }}
                  className="group relative border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] p-4 sm:p-6 md:p-8 brutal-shadow transition-all hover:bg-[var(--color-surface-0)] hover:-translate-y-1"
                >
                  <div className="mb-6 flex flex-wrap items-center gap-2 sm:gap-3 font-mono text-[10px] sm:text-xs font-bold uppercase">
                    <span className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-2)] px-2 sm:px-3 py-1.5 text-[var(--color-fg-primary)] brutal-shadow shadow-sm">
                      {normalizeLabel(law.source)}
                    </span>
                    <span className="border-2 border-[var(--color-accent)] bg-[var(--color-surface-0)] px-2 sm:px-3 py-1.5 text-[var(--color-accent)] brutal-shadow shadow-sm">
                      {normalizeLabel(law.category)}
                    </span>
                    <span
                      title={freshnessDescription(law.freshness)}
                      className={`px-2 sm:px-3 py-1.5 border-2 shadow-sm ${freshnessTone(law.freshness)}`}
                    >
                      STATUS: {freshnessLabel(law.freshness)}
                    </span>
                  </div>

                  <h3 className="mb-4 text-2xl md:text-3xl lg:text-4xl text-[var(--color-fg-primary)] tracking-tight break-words">
                    {law.title}
                  </h3>
                  <p className="mb-8 font-sans text-sm md:text-base leading-relaxed text-[var(--color-fg-muted)] max-w-4xl border-l-4 border-[var(--color-fg-primary)] pl-4 py-1 break-words">
                    {renderHighlightedText(law.summary, searchTerms)}
                  </p>

                  {excerptText ? (
                    <p className="mb-8 border-l-4 border-[var(--color-accent)] bg-[var(--color-surface-0)] px-4 py-3 font-mono text-xs uppercase leading-relaxed tracking-wide text-[var(--color-fg-muted)]">
                      Excerpt: {renderHighlightedText(excerptText, searchTerms)}
                    </p>
                  ) : null}

                  <div className="mb-8 flex flex-wrap items-center gap-6 font-mono text-xs font-bold uppercase text-[var(--color-fg-muted)] border-y-2 border-[var(--color-fg-primary)] py-4 bg-[var(--color-surface-2)] px-4">
                    {law.lawNumber && (
                      <span className="flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 bg-[var(--color-fg-primary)] rounded-full"></span>
                        REF: {law.lawNumber}
                      </span>
                    )}
                    {law.enactedOn && (
                      <span className="flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 bg-[var(--color-accent)] rounded-full"></span>
                        ENACTED: {law.enactedOn}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4">
                    <Link
                      href={readerHref}
                      onClick={rememberExplorerScroll}
                      className="inline-flex w-full sm:w-auto justify-center items-center gap-2 border-2 border-[var(--color-accent)] bg-[var(--color-accent)] px-4 sm:px-5 py-2.5 font-mono text-xs font-bold uppercase text-[var(--color-surface-0)] transition-transform hover:-translate-y-1 hover:brutal-shadow"
                    >
                      Read in Juris
                      <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </Link>

                    <a
                      href={law.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-full sm:w-auto justify-center items-center gap-2 border-2 border-[var(--color-fg-primary)] bg-[var(--color-fg-primary)] px-4 sm:px-5 py-2.5 font-mono text-xs font-bold uppercase text-[var(--color-surface-0)] transition-transform hover:-translate-y-1 hover:brutal-shadow"
                    >
                      Retrieve Document
                      <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </a>

                    <button
                      type="button"
                      onClick={() => toggleBookmark(law.id)}
                      className={`inline-flex w-full sm:w-auto justify-center items-center gap-2 border-2 px-4 sm:px-5 py-2.5 font-mono text-xs font-bold uppercase transition-transform hover:-translate-y-1 hover:brutal-shadow ${isBookmarked ? "bg-[var(--color-accent)] text-[var(--color-surface-0)] border-[var(--color-accent)]" : "bg-[var(--color-surface-1)] text-[var(--color-fg-primary)] border-[var(--color-fg-primary)]"}`}
                    >
                      {isBookmarked ? (
                        <BookmarkCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                      ) : (
                        <Bookmark className="h-4 w-4 shrink-0" aria-hidden="true" />
                      )}
                      {isBookmarked ? "In Registry" : "Save"}
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleReadLater(law.id)}
                      className={`inline-flex w-full sm:w-auto justify-center items-center gap-2 border-2 px-4 sm:px-5 py-2.5 font-mono text-xs font-bold uppercase transition-transform hover:-translate-y-1 hover:brutal-shadow ${isReadLater ? "bg-[var(--color-fg-primary)] text-[var(--color-surface-0)] border-[var(--color-fg-primary)]" : "bg-[var(--color-surface-1)] text-[var(--color-fg-primary)] border-[var(--color-fg-primary)]"}`}
                    >
                      <Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {isReadLater ? "Queued" : "Queue"}
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Sidebar / Arsenal */}
        <aside className="space-y-8 animate-slide-up-cascade md:sticky top-24 self-start">
          <Panel
            title="Registry"
            icon={<BookMarked className="h-5 w-5" aria-hidden="true" />}
            subtitle="Saved Archives"
          >
            {bookmarkedLaws.length ? (
              <ul className="space-y-4">
                {bookmarkedLaws.slice(0, 8).map((law) => (
                  <li key={law.id} className="border-b-2 border-dashed border-[var(--color-fg-primary)] pb-4 hover:pl-2 transition-all">
                    <p className="font-bold text-sm leading-snug text-[var(--color-fg-primary)]">{law.title}</p>
                    <a
                      href={law.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-2 font-mono text-xs font-bold uppercase bg-[var(--color-accent)] text-[var(--color-surface-0)] px-2 py-1 transition-transform hover:-translate-y-0.5 brutal-shadow shadow-sm"
                    >
                      Read Archive
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="bg-[var(--color-surface-2)] p-4 border border-[var(--color-fg-muted)]">
                <p className="font-mono text-xs uppercase text-[var(--color-fg-muted)] font-bold text-center">Registry Empty</p>
              </div>
            )}
          </Panel>

          <Panel
            title="Queue"
            icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
            subtitle="Pending Review"
          >
            {readLaterLaws.length ? (
              <ul className="space-y-3 font-mono text-xs">
                {readLaterLaws.slice(0, 8).map((law) => (
                  <li key={law.id} className="border-l-4 border-[var(--color-fg-primary)] pl-3 bg-[var(--color-surface-1)] py-2 pr-2">
                    <p className="font-bold text-[var(--color-fg-primary)] truncate" title={law.title}>{law.title}</p>
                    <p className="mt-1 text-[var(--color-fg-muted)] uppercase text-[10px] tracking-widest">{normalizeLabel(law.source)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="bg-[var(--color-surface-2)] p-4 border border-[var(--color-fg-muted)]">
                <p className="font-mono text-xs uppercase text-[var(--color-fg-muted)] font-bold text-center">Queue Empty</p>
              </div>
            )}
          </Panel>
          
          <Panel
            title="Source Health"
            icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
            subtitle="Freshness, checks, and text coverage"
          >
            <div className="space-y-4">
              {sourceCoverage.map((sourceInfo) => (
                <div
                  key={sourceInfo.id}
                  className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] p-4 text-sm brutal-shadow hover:-translate-y-1 transition-transform"
                >
                  <p className="font-bold font-sans tracking-tight leading-none text-base">{sourceInfo.name}</p>
                  <p className="mt-3 font-mono text-xs font-bold uppercase text-[var(--color-fg-muted)] flex justify-between bg-[var(--color-surface-2)] px-2 py-1">
                    <span>Source Mode: {sourceInfo.mode}</span>
                    <span className="text-[var(--color-accent)]">Health: {sourceInfo.healthScore}</span>
                  </p>

                  <div className="mt-3 h-2 w-full bg-[var(--color-surface-2)] border border-[var(--color-fg-primary)]">
                    <div className="h-full bg-[var(--color-fg-primary)]" style={{ width: `${sourceInfo.healthScore}%` }}></div>
                  </div>

                  <div className="mt-3 space-y-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    <p>Indexed: {sourceInfo.indexedCount.toLocaleString()}</p>
                    <p>Fresh/API: {formatPercent(sourceInfo.freshRate)}</p>
                    <p>Recently Checked (45d): {formatPercent(sourceInfo.recentVerificationRate)}</p>
                    <p>Text Coverage: {formatPercent(sourceInfo.textCoverageRate)}</p>
                    <p>Blocked: {formatPercent(sourceInfo.blockedRate)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </section>
    </div>
  );
}

function MultiSelectDropdown({
  buttonLabel,
  isOpen,
  onToggle,
  options,
  selectedValues,
  onToggleValue,
  onSelectAll,
  onClear,
  emptyHint,
}: {
  buttonLabel: string;
  isOpen: boolean;
  onToggle: () => void;
  options: Array<{ label: string; value: string }>;
  selectedValues: Set<string>;
  onToggleValue: (value: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  emptyHint: string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-14 w-full items-center justify-between border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] px-4 font-mono text-left text-sm font-bold uppercase text-[var(--color-fg-primary)] transition-all hover:bg-[var(--color-surface-0)] focus:brutal-shadow"
      >
        <span className="truncate">{buttonLabel}</span>
        <svg
          className={`h-4 w-4 shrink-0 fill-current transition-transform ${isOpen ? "rotate-180" : "rotate-0"}`}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M5.516 7.548c0.436-0.446 1.043-0.481 1.576 0l2.908 2.89 2.908-2.89c0.533-0.481 1.141-0.446 1.574 0 0.436 0.445 0.408 1.197 0 1.615l-3.695 3.695c-0.218 0.223-0.502 0.335-0.787 0.335s-0.569-0.112-0.789-0.335l-3.695-3.695c-0.408-0.418-0.436-1.17 0-1.615z" />
        </svg>
      </button>

      {isOpen ? (
        <div className="absolute z-30 mt-2 max-h-80 w-full overflow-hidden border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] brutal-shadow">
          <div className="flex items-center justify-between border-b-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] px-2 py-2">
            <button
              type="button"
              onClick={onSelectAll}
              className="border border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[var(--color-fg-primary)]"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={onClear}
              className="border border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[var(--color-fg-primary)]"
            >
              Clear
            </button>
          </div>

          <div className="max-h-60 overflow-y-auto p-2">
            {options.map((option) => (
              <label
                key={option.value}
                className="mb-1 flex cursor-pointer items-center gap-2 border border-transparent px-2 py-1 font-mono text-xs font-bold uppercase text-[var(--color-fg-primary)] hover:border-[var(--color-fg-primary)] hover:bg-[var(--color-surface-1)]"
              >
                <input
                  type="checkbox"
                  checked={selectedValues.has(option.value)}
                  onChange={() => onToggleValue(option.value)}
                  className="h-4 w-4 border-2 border-[var(--color-fg-primary)] accent-[var(--color-accent)]"
                />
                <span className="leading-tight">{option.label}</span>
              </label>
            ))}
          </div>

          {!selectedValues.size ? (
            <p className="border-t border-[var(--color-fg-primary)] px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wide text-[var(--color-fg-muted)]">
              {emptyHint}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, inverted }: { label: string; value: string; inverted?: boolean }) {
  return (
    <div className={`p-4 border-2 ${inverted ? "border-[var(--color-surface-0)] bg-[var(--color-accent)] text-[var(--color-surface-0)]" : "border-[var(--color-fg-primary)] bg-[var(--color-surface-1)]"} brutal-shadow`}>
      <p className={`font-mono text-[10px] font-bold uppercase tracking-widest ${inverted ? "text-white opacity-80" : "text-[var(--color-fg-muted)]"}`}>{label}</p>
      <p className="mt-2 text-3xl font-black">{value}</p>
    </div>
  );
}

function Panel({
  title,
  icon,
  subtitle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] p-6 brutal-shadow">
      <h2 className="mb-2 inline-flex items-center gap-3 font-mono text-sm font-bold uppercase tracking-widest text-[var(--color-fg-primary)] border-b-4 border-[var(--color-fg-primary)] pb-3 w-full">
        {icon}
        {title}
      </h2>
      <p className="mb-6 font-sans text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)] mt-2">{subtitle}</p>
      {children}
    </section>
  );
}
