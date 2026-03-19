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

const limitSchema = z.coerce.number().int().positive().max(100);
const offsetSchema = z.coerce.number().int().min(0);
const optionalBroadSchema = broadSchema.optional();
const optionalLimitSchema = limitSchema.optional();
const optionalOffsetSchema = offsetSchema.optional();
const optionalSourcesSchema = z.array(sourceSchema).optional();
const optionalCategoriesSchema = z.array(categorySchema).optional();

function parseMultiValueParam(searchParams: URLSearchParams, key: string): string[] {
  return searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;

  const broadParam = url.searchParams.get("broad");
  const broadParsed = optionalBroadSchema.safeParse(broadParam ?? undefined);

  const limitParam = url.searchParams.get("limit");
  const limitParsed = optionalLimitSchema.safeParse(limitParam ?? undefined);

  const offsetParam = url.searchParams.get("offset");
  const offsetParsed = optionalOffsetSchema.safeParse(offsetParam ?? undefined);

  const sourceValues = parseMultiValueParam(url.searchParams, "source");
  const includeAllSources = sourceValues.includes("all");
  const sourceParsed = optionalSourcesSchema.safeParse(
    includeAllSources
      ? undefined
      : sourceValues.length
        ? sourceValues
        : undefined,
  );

  const categoryValues = parseMultiValueParam(url.searchParams, "category");
  const includeAllCategories = categoryValues.includes("all");
  const categoryParsed = optionalCategoriesSchema.safeParse(
    includeAllCategories
      ? undefined
      : categoryValues.length
        ? categoryValues
        : undefined,
  );

  if (!broadParsed.success || !limitParsed.success || !offsetParsed.success || !sourceParsed.success || !categoryParsed.success) {
    const issues = [
      ...(broadParsed.success ? [] : broadParsed.error.issues),
      ...(limitParsed.success ? [] : limitParsed.error.issues),
      ...(offsetParsed.success ? [] : offsetParsed.error.issues),
      ...(sourceParsed.success ? [] : sourceParsed.error.issues),
      ...(categoryParsed.success ? [] : categoryParsed.error.issues),
    ];

    return NextResponse.json(
      {
        success: false,
        error: "Invalid search query",
        issues,
      },
      { status: 400 },
    );
  }

  const result = searchLaws({
    q,
    broad: broadParsed.data,
    limit: limitParsed.data,
    offset: offsetParsed.data,
    sources: sourceParsed.data,
    categories: categoryParsed.data,
  });

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
