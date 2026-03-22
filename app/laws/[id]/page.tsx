import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, FileText, Scale } from "lucide-react";

import { getLawById } from "@/lib/law-repository";
import { ScrollToTop } from "@/components/scroll-to-top";

interface LawReaderPageProps {
  params: Promise<{
    id: string;
  }>;
  searchParams: Promise<{
    q?: string;
    back?: string;
  }>;
}

const SEARCH_STOP_WORDS = new Set([
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

function normalizeParagraphText(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkLongParagraph(paragraph: string, maxLength = 850): string[] {
  if (paragraph.length <= maxLength) {
    return [paragraph];
  }

  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const nextChunk = current ? `${current} ${sentence}` : sentence;

    if (nextChunk.length > maxLength && current) {
      chunks.push(current);
      current = sentence;
      continue;
    }

    current = nextChunk;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function toParagraphs(text: string): string[] {
  const normalized = text.replace(/\r/g, "\n").trim();

  if (!normalized) {
    return [];
  }

  const naturalParagraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => normalizeParagraphText(paragraph))
    .filter(Boolean);

  if (naturalParagraphs.length >= 2) {
    return naturalParagraphs.flatMap((paragraph) => chunkLongParagraph(paragraph));
  }

  const flattened = normalizeParagraphText(normalized);

  if (!flattened) {
    return [];
  }

  return chunkLongParagraph(flattened);
}

function sanitizeReaderNoise(text?: string): string {
  if (!text) {
    return "";
  }

  return text
    .replace(/\b\d+\s+of\s+\d+\b/gi, " ")
    .replace(/^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(am|pm)\s*$/gim, " ")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/(?:\s*-\s*){4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(isoDate?: string): string {
  if (!isoDate) {
    return "Date unavailable";
  }

  const parsed = new Date(isoDate);

  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }

  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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

function looksLikePdfUrl(value: string): boolean {
  return /\.pdf(?:$|[?#])/i.test(value);
}

function isPdfResponseContentType(contentType: string | null, url: string): boolean {
  const normalized = (contentType ?? "").toLowerCase();

  if (!normalized) {
    return looksLikePdfUrl(url);
  }

  return (
    normalized.includes("application/pdf") ||
    normalized.includes("application/octet-stream") ||
    looksLikePdfUrl(url)
  );
}

async function resolveReachableSourcePdfUrl(rawUrl?: string): Promise<string | undefined> {
  if (!rawUrl) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (!parsed.protocol.startsWith("http") || !looksLikePdfUrl(`${parsed.pathname}${parsed.search}`)) {
    return undefined;
  }

  const requestHeaders = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
  };

  try {
    const headResponse = await fetch(parsed.toString(), {
      method: "HEAD",
      headers: requestHeaders,
      cache: "force-cache",
      next: { revalidate: 21600 },
    });

    if (headResponse.ok && isPdfResponseContentType(headResponse.headers.get("content-type"), parsed.toString())) {
      return parsed.toString();
    }

    if (![403, 405, 501].includes(headResponse.status)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const rangeResponse = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        ...requestHeaders,
        range: "bytes=0-1023",
      },
      cache: "no-store",
    });

    if (!rangeResponse.ok) {
      return undefined;
    }

    if (!isPdfResponseContentType(rangeResponse.headers.get("content-type"), parsed.toString())) {
      return undefined;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function decodeBackHref(rawBack: string): string {
  try {
    return decodeURIComponent(rawBack);
  } catch {
    return rawBack;
  }
}

function resolveBackHref(rawBack?: string): string {
  if (!rawBack) {
    return "/";
  }

  const candidate = decodeBackHref(rawBack.trim());

  if (!candidate.startsWith("/")) {
    return "/";
  }

  if (candidate.startsWith("//")) {
    return "/";
  }

  return candidate;
}

export default async function LawReaderPage({ params, searchParams }: LawReaderPageProps) {
  const [{ id: rawId }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const id = decodeURIComponent(rawId ?? "");
  const query = typeof resolvedSearchParams.q === "string" ? resolvedSearchParams.q : "";
  const backHref =
    typeof resolvedSearchParams.back === "string"
      ? resolveBackHref(resolvedSearchParams.back)
      : "/";
  const searchTerms = buildSearchTerms(query);

  const law = getLawById(id);

  if (!law) {
    notFound();
  }

  const preferredBodyText = law.fullText && !isNoisyReaderText(law.fullText) ? law.fullText : undefined;
  const readableText = sanitizeReaderNoise(preferredBodyText || law.fullTextPreview || law.summary);
  const paragraphs = toParagraphs(readableText);
  const hasScrapedBody = Boolean(preferredBodyText && preferredBodyText.length > 200);
  const declaredSourcePdfUrl = law.sourcePdfUrl;
  const reachableSourcePdfUrl = await resolveReachableSourcePdfUrl(declaredSourcePdfUrl);
  const hasSourcePdf = Boolean(reachableSourcePdfUrl);
  const hasDeclaredSourcePdf = Boolean(declaredSourcePdfUrl);
  const sourcePdfProxyUrl = hasSourcePdf
    ? `/api/laws/pdf?url=${encodeURIComponent(reachableSourcePdfUrl ?? "")}`
    : undefined;
  const readerModeLabel = hasScrapedBody
    ? hasSourcePdf
      ? "Reader Mode: Captured PDF + Source Text"
      : "Reader Mode: Captured Source Text"
    : hasSourcePdf
      ? "Reader Mode: PDF-Linked Preview Extract"
      : "Reader Mode: Preview Extract";

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-20 pt-10 sm:px-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={backHref}
          className="group inline-flex items-center gap-3 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)] hover:text-[var(--color-accent)] transition-colors"
        >
          <ArrowLeft className="h-5 w-5 transition-transform group-hover:-translate-x-1" aria-hidden="true" />
          Back to Search
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          {hasSourcePdf && sourcePdfProxyUrl ? (
            <a
              href={sourcePdfProxyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-primary)] transition-transform hover:-translate-y-1 hover:brutal-shadow"
            >
              View Source PDF
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : null}

          <a
            href={law.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border-2 border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-surface-0)] transition-transform hover:-translate-y-1 hover:brutal-shadow"
          >
            View Original Source
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </div>

      <section className="mb-8 border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] p-6 md:p-8 brutal-shadow">
        <p className="mb-4 inline-flex items-center gap-2 border-b-2 border-[var(--color-fg-primary)] pb-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
          <Scale className="h-4 w-4" aria-hidden="true" />
          Juris Reader
        </p>

        <h1 className="text-3xl font-black uppercase tracking-tight text-[var(--color-fg-primary)] md:text-5xl">
          {law.title}
        </h1>

        {searchTerms.length ? (
          <p className="mt-4 inline-flex border-l-4 border-[var(--color-accent)] bg-[var(--color-surface-0)] px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
            Highlighting matches for: {query}
          </p>
        ) : null}

        <p className="mt-6 font-mono text-xs font-bold uppercase tracking-wide text-[var(--color-fg-primary)]">
          SOURCE: {law.source.replaceAll("_", " ")} | CATEGORY: {law.category.replaceAll("_", " ")}
          {law.lawNumber ? ` | REF: ${law.lawNumber}` : ""} | ENACTED: {formatDate(law.enactedOn)}
          {hasSourcePdf
            ? " | DOCUMENT: PDF AVAILABLE"
            : hasDeclaredSourcePdf
              ? " | DOCUMENT: PDF UNAVAILABLE UPSTREAM"
              : ""}
        </p>
      </section>

      {hasSourcePdf && sourcePdfProxyUrl ? (
        <section className="mb-8 border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] p-6 md:p-8 brutal-shadow">
          <p className="inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
            <FileText className="h-4 w-4" aria-hidden="true" />
            Embedded Source PDF
          </p>

          <div className="mt-4 overflow-hidden border-2 border-[var(--color-fg-primary)] bg-white">
            <iframe
              src={sourcePdfProxyUrl}
              title={`Source PDF for ${law.title}`}
              className="h-[78vh] min-h-[500px] w-full"
              loading="lazy"
            />
          </div>

          <p className="mt-4 font-mono text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            Viewer uses Juris PDF proxy for reliable in-site rendering. If the panel is blank, use the View Source PDF button above.
          </p>
        </section>
      ) : null}

      <section className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] p-6 md:p-10 brutal-shadow">
        <p className="mb-6 inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
          <FileText className="h-4 w-4" aria-hidden="true" />
          {readerModeLabel}
        </p>

        {!hasScrapedBody ? (
          <div className="mb-8 border-l-4 border-[var(--color-accent)] bg-[var(--color-surface-1)] px-4 py-3 font-mono text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            {hasSourcePdf
              ? "Full body text is not yet available for this entry. Juris is showing the best available preview while keeping the source PDF viewer above."
              : "Full body text is not yet available for this entry. Juris is showing the best available preview while preserving the source link above."}
          </div>
        ) : null}

        <article className="space-y-5 font-sans text-base leading-relaxed text-[var(--color-fg-primary)] md:text-lg">
          {paragraphs.length ? (
            paragraphs.map((paragraph, index) => (
              <p key={`${law.id}-${index}`}>{renderHighlightedText(paragraph, searchTerms)}</p>
            ))
          ) : (
            <p>{renderHighlightedText(law.summary, searchTerms)}</p>
          )}
        </article>
      </section>

      <ScrollToTop />
    </main>
  );
}
