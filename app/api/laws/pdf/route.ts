import { NextResponse } from "next/server";

const ALLOWED_HOST_SUFFIXES = ["officialgazette.gov.ph"];
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function isAllowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

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
      return NextResponse.json(
        {
          success: false,
          error: `Upstream request failed (${upstream.status})`,
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
    headers.set("content-type", "application/pdf");
    headers.set("content-disposition", "inline; filename=\"official-gazette-source.pdf\"");
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