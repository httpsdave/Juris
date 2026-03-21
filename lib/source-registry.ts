import type { LawSourceId, SourceProfile } from "@/types/law";

export const sourceProfiles: Record<LawSourceId, SourceProfile> = {
  lawphil: {
    id: "lawphil",
    name: "The Lawphil Project",
    mode: "scrape",
    baseUrl: "https://lawphil.net/",
    isOfficial: false,
    reliabilityScore: 78,
    accessNotes: "Public HTML pages with broad legal corpus and legacy structure.",
    updateNotes: "Good historical coverage; metadata quality varies by section.",
  },
  official_gazette: {
    id: "official_gazette",
    name: "Official Gazette",
    mode: "hybrid",
    baseUrl: "https://www.officialgazette.gov.ph/",
    isOfficial: true,
    reliabilityScore: 95,
    accessNotes:
      "Public pages for republic acts and executive issuances; many entries include embedded signed PDF documents.",
    updateNotes: "High authority source and usually close to signing/publication dates; scraper preserves source PDF links when present.",
  },
  chanrobles: {
    id: "chanrobles",
    name: "ChanRobles Virtual Law Library",
    mode: "scrape",
    baseUrl: "https://chanrobles.com/virtualibrary1.htm",
    isOfficial: false,
    reliabilityScore: 72,
    accessNotes: "Legacy HTML index with many topic hubs and deep-link legal pages.",
    updateNotes: "Useful for discoverability and legacy references; verify against primary sources.",
  },
  congress: {
    id: "congress",
    name: "Congress Legislative Portal",
    mode: "scrape",
    baseUrl: "https://www.congress.gov.ph/legis/",
    isOfficial: true,
    reliabilityScore: 88,
    accessNotes:
      "Listing pages can return HTTP 403 to bots; scraper falls back to direct PDF probing in docs.congress.hrep.online using document number patterns.",
    updateNotes:
      "Tracks House Bills, Republic Acts, Adopted Resolutions, and Committee Reports incrementally via checkpoint cursors.",
  },
  judiciary_elibrary: {
    id: "judiciary_elibrary",
    name: "Supreme Court E-Library",
    mode: "scrape",
    baseUrl: "https://elibrary.judiciary.gov.ph/republic_acts",
    isOfficial: true,
    reliabilityScore: 94,
    accessNotes: "Public searchable table-style listings with large republic acts index.",
    updateNotes: "Strong legal authority and broad entry volume.",
  },
  open_congress: {
    id: "open_congress",
    name: "Open Congress API",
    mode: "api",
    baseUrl: "https://open-congress-api.bettergov.ph/api",
    isOfficial: false,
    reliabilityScore: 86,
    accessNotes:
      "Public REST API with OpenAPI spec at /api/doc and rich endpoints for documents and legislators.",
    updateNotes:
      "Community-maintained dataset; validate key legal text against primary government sources.",
  },
};

export function getSourceProfile(sourceId: LawSourceId): SourceProfile {
  return sourceProfiles[sourceId];
}

export function getAllSourceProfiles(): SourceProfile[] {
  return Object.values(sourceProfiles);
}
