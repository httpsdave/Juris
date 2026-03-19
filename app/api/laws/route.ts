import { NextResponse } from "next/server";
import { z } from "zod";

import { searchLaws } from "@/lib/law-repository";

const sourceSchema = z.enum([
  "lawphil",
  "official_gazette",
  "chanrobles",
  "congress",
  "judiciary_elibrary",
  "open_congress",
]);

const categorySchema = z.enum([
  "constitution",
  "republic_act",
  "executive_issuance",
  "jurisprudence",
  "bill",
  "code",
  "rule",
  "ordinance",
  "other",
]);

const broadSchema = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .transform((value) => value === "true" || value === "1");

const querySchema = z.object({
  q: z.string().optional(),
  source: z.union([z.literal("all"), sourceSchema]).optional(),
  category: z.union([z.literal("all"), categorySchema]).optional(),
  broad: broadSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid search query",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const result = searchLaws(parsed.data);

  return NextResponse.json({
    success: true,
    data: result.items,
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.offset + result.items.length < result.total,
    },
    query: result.query,
  });
}
