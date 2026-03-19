const OPEN_CONGRESS_API_BASE =
  process.env.OPEN_CONGRESS_API_BASE ?? "https://open-congress-api.bettergov.ph/api";

export interface OpenCongressStats {
  totalBills: number;
  totalHouseBills: number;
  totalSenateBills: number;
  totalCongresses: number;
  totalPeople: number;
  totalCommittees: number;
}

interface OpenCongressEnvelope<T> {
  success: boolean;
  data: T;
}

interface OpenCongressStatsResponse {
  total_bills: number;
  total_house_bills: number;
  total_senate_bills: number;
  total_congresses: number;
  total_people: number;
  total_committees: number;
}

export interface OpenCongressDocument {
  id: string;
  subtype?: string;
  name?: string;
  title?: string;
  long_title?: string;
  date_filed?: string;
  scope?: string;
  congress?: number;
}

export async function fetchOpenCongressStats(): Promise<OpenCongressStats> {
  const response = await fetch(`${OPEN_CONGRESS_API_BASE}/stats`, {
    next: {
      revalidate: 60 * 30,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Open Congress stats. Status ${response.status}`);
  }

  const payload = (await response.json()) as OpenCongressEnvelope<OpenCongressStatsResponse>;

  if (!payload.success) {
    throw new Error("Open Congress stats request was not successful.");
  }

  return {
    totalBills: payload.data.total_bills,
    totalHouseBills: payload.data.total_house_bills,
    totalSenateBills: payload.data.total_senate_bills,
    totalCongresses: payload.data.total_congresses,
    totalPeople: payload.data.total_people,
    totalCommittees: payload.data.total_committees,
  };
}

export async function searchOpenCongressDocuments(input: {
  query?: string;
  congress?: string;
  subtype?: string;
  limit?: number;
  offset?: number;
}): Promise<OpenCongressDocument[]> {
  const url = new URL(`${OPEN_CONGRESS_API_BASE}/search/documents`);
  url.searchParams.set("q", input.query || "education");

  if (input.congress && input.congress !== "all") {
    url.searchParams.set("congress", input.congress);
  }

  if (input.subtype && input.subtype !== "any") {
    url.searchParams.set("subtype", input.subtype);
  }

  url.searchParams.set("limit", String(input.limit ?? 10));
  url.searchParams.set("offset", String(input.offset ?? 0));

  const response = await fetch(url.toString(), {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to search Open Congress documents. Status ${response.status}`);
  }

  const payload = (await response.json()) as OpenCongressEnvelope<OpenCongressDocument[]>;

  if (!payload.success) {
    return [];
  }

  return payload.data;
}
