// Google Places API (New) client for the sourcing agent — the ONLY approved
// business-listing source (spec §6: official APIs, never scraping). Every
// request is counted and priced so a run can be audited and capped.
// PLACES_MOCK=1 serves fixtures instead, so the pipeline is testable without
// a key and tests never spend money.
import fs from "fs";
import path from "path";

const KEY = () => process.env.GOOGLE_PLACES_API_KEY ?? "";
export const placesConfigured = (): boolean => Boolean(KEY()) || process.env.PLACES_MOCK === "1";

// Text Search with the fields we need (phone/website live in the Pro tier);
// ~$35 per 1000 requests as of 2026 — logged as an estimate, not billing truth.
const COST_PER_CALL_USD = 0.035;

export interface PlaceResult {
  place_id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  rating: number | null;
  review_count: number | null;
}

export interface PlacesUsage {
  calls: number;
  estCostUsd: number;
}

export class PlacesClient {
  usage: PlacesUsage = { calls: 0, estCostUsd: 0 };
  constructor(private maxCalls: number) {}

  private spend(): void {
    if (this.usage.calls >= this.maxCalls)
      throw new Error(`Places call cap reached (${this.maxCalls}) — raise limits.max_places_calls_per_run deliberately if intended`);
    this.usage.calls++;
    this.usage.estCostUsd = Number((this.usage.calls * COST_PER_CALL_USD).toFixed(3));
  }

  // One page of Text Search results (<=20). pageToken continues a search.
  async textSearch(
    query: string,
    lat: number,
    lng: number,
    radiusM: number,
    pageToken?: string
  ): Promise<{ places: PlaceResult[]; nextPageToken: string | null }> {
    this.spend();
    if (process.env.PLACES_MOCK === "1") return this.mock(query, pageToken);
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY(),
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.nationalPhoneNumber,places.websiteUri,places.formattedAddress,places.rating,places.userRatingCount,places.businessStatus,nextPageToken",
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM } },
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Places textSearch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as any;
    const places: PlaceResult[] = (j.places ?? [])
      .filter((p: any) => (p.businessStatus ?? "OPERATIONAL") === "OPERATIONAL")
      .map((p: any) => ({
        place_id: p.id,
        business_name: p.displayName?.text ?? "(unknown)",
        phone: p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        address: p.formattedAddress ?? null,
        rating: p.rating ?? null,
        review_count: p.userRatingCount ?? null,
      }));
    return { places, nextPageToken: j.nextPageToken ?? null };
  }

  private mock(query: string, pageToken?: string): { places: PlaceResult[]; nextPageToken: string | null } {
    const fixture = path.join(process.cwd(), "evals", "places-mock.json");
    const all = JSON.parse(fs.readFileSync(fixture, "utf8")) as Record<string, PlaceResult[]>;
    const key = Object.keys(all).find((k) => query.toLowerCase().includes(k)) ?? Object.keys(all)[0];
    // mock has one page per query; pageToken always ends it
    return { places: pageToken ? [] : all[key] ?? [], nextPageToken: null };
  }
}
