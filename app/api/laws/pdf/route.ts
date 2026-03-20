import { NextResponse } from "next/server";

import { getAllSourceProfiles } from "@/lib/source-registry";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

function parseExtraAllowedHostSuffixes(): string[] {
  const raw = process.env.LAW_PDF_PROXY_ALLOWED_HOST_SUFFIXES;

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry) => /^[a-z0-9.-]+$/.test(entry));
}

function buildAllowedHostSuffixes(): string[] {
  const suffixes = new Set<string>(["officialgazette.gov.ph"]);

  for (const profile of getAllSourceProfiles()) {
    try {
      const hostname = normalizeHost(new URL(profile.baseUrl).hostname);

      if (hostname) {
        suffixes.add(hostname);
      }
    } catch {
      continue;
    }
  }

  for (const suffix of parseExtraAllowedHostSuffixes()) {
    suffixes.add(suffix);
  }

  return Array.from(suffixes);
}

const ALLOWED_HOST_SUFFIXES = buildAllowedHostSuffixes();

function isAllowedHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);

  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function looksLikePdf(url: URL): boolean {
  return /\.pdf(?:$|[?#])/i.test(`${url.pathname}${url.search}`);
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const rawTarget = requestUrl.searchParams.get("url");

  if (!rawTarget) {
    return NextResponse.json(
      {
        success: false,
        error: "Missing required query parameter: url",
      },
      { status: 400 },
    );
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(rawTarget);
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid target URL",
      },
      { status: 400 },
    );
  }

  if (!isAllowedHost(targetUrl.hostname)) {
    return NextResponse.json(
      {
        success: false,
        error: "Host is not allowed for PDF proxying",
      },
      { status: 403 },
    );
  }

  if (!["http:", "https:"].includes(targetUrl.protocol) || !looksLikePdf(targetUrl)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only direct PDF links are supported",
      },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      const upstreamError =
        upstream.status === 404
          ? "Upstream PDF not found (404). This source entry may not publish a PDF file."
          : `Upstream request failed (${upstream.status})`;

      return NextResponse.json(
        {
          success: false,
          error: upstreamError,
        },
        { status: upstream.status },
      );
    }

    const announcedSize = Number(upstream.headers.get("content-length") ?? "0");

    if (Number.isFinite(announcedSize) && announcedSize > MAX_PDF_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: "Upstream PDF exceeds size limit",
        },
        { status: 413 },
      );
    }

    const body = await upstream.arrayBuffer();

    if (body.byteLength > MAX_PDF_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: "Upstream PDF exceeds size limit",
        },
        { status: 413 },
      );
    }

    const headers = new Headers();
    const normalizedHost = normalizeHost(targetUrl.hostname).replace(/[^a-z0-9.-]/g, "");
    const fileLabel = normalizedHost || "source";

    headers.set("content-type", "application/pdf");
    headers.set("content-disposition", `inline; filename=\"${fileLabel}-source.pdf\"`);
    headers.set("cache-control", "public, max-age=21600, s-maxage=21600");
    headers.set("x-content-type-options", "nosniff");

    return new Response(body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown upstream error",
      },
      { status: 502 },
    );
  }
}