import { NextResponse } from "next/server";

import { fetchOpenCongressStats } from "@/lib/open-congress";

export async function GET() {
  try {
    const stats = await fetchOpenCongressStats();

    return NextResponse.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch Open Congress stats",
      },
      { status: 502 },
    );
  }
}
