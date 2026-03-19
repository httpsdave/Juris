import { NextResponse } from "next/server";

import { searchOpenCongressDocuments } from "@/lib/open-congress";

export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const documents = await searchOpenCongressDocuments({
      query: url.searchParams.get("q") ?? undefined,
      congress: url.searchParams.get("congress") ?? undefined,
      subtype: url.searchParams.get("subtype") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 8),
      offset: Number(url.searchParams.get("offset") ?? 0),
    });

    return NextResponse.json({
      success: true,
      data: documents,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to query Open Congress documents",
      },
      { status: 502 },
    );
  }
}
