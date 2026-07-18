// Sourcing agent (Milestone 1): populate local_leads for the active metros.
//   npm run leads:source                # all active metros
//   npm run leads:source -- --metro orlando-trades
// Idempotent: place_id dedup means reruns add nothing. Every run logs API
// calls, estimated cost, and found/new counts (spec §6 auditability).
import fs from "fs";
import path from "path";
import { PlacesClient, placesConfigured } from "./places.js";
import { insertLocalLead, upsertMetro, MetroConfig } from "./store.js";

interface MetrosFile {
  limits: { max_places_calls_per_run: number; max_new_leads_per_run: number };
  metros: MetroConfig[];
}

export function loadMetros(): MetrosFile {
  const p = path.join(process.cwd(), "config", "metros.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as MetrosFile;
}

export interface SourceRunResult {
  metro: string;
  found: number;
  added: number;
  calls: number;
  estCostUsd: number;
}

export async function sourceMetro(metro: MetroConfig, limits: MetrosFile["limits"]): Promise<SourceRunResult> {
  upsertMetro(metro);
  const client = new PlacesClient(limits.max_places_calls_per_run);
  let found = 0;
  let added = 0;
  for (const q of metro.queries) {
    let pageToken: string | undefined;
    // up to 3 pages (60 results) per query, bounded by the global call cap
    for (let page = 0; page < 3; page++) {
      const { places, nextPageToken } = await client.textSearch(
        `${q} in ${metro.name}`,
        metro.lat,
        metro.lng,
        metro.radius_m,
        pageToken
      );
      found += places.length;
      for (const p of places) {
        if (added >= limits.max_new_leads_per_run) break;
        if (insertLocalLead(metro.id, p) !== null) added++;
      }
      if (!nextPageToken || added >= limits.max_new_leads_per_run) break;
      pageToken = nextPageToken;
    }
    if (added >= limits.max_new_leads_per_run) break;
  }
  return { metro: metro.id, found, added, calls: client.usage.calls, estCostUsd: client.usage.estCostUsd };
}

export async function sourceAll(onlyMetro?: string): Promise<SourceRunResult[]> {
  if (!placesConfigured())
    throw new Error("GOOGLE_PLACES_API_KEY is not set (or PLACES_MOCK=1 for fixtures) — sourcing needs one of them");
  const { limits, metros } = loadMetros();
  const targets = metros.filter((m) => m.active && (!onlyMetro || m.id === onlyMetro));
  if (!targets.length) throw new Error(`no active metro matches "${onlyMetro ?? "(any)"}" in config/metros.json`);
  const results: SourceRunResult[] = [];
  for (const m of targets) results.push(await sourceMetro(m, limits));
  return results;
}

// CLI entry
const isMain = process.argv[1]?.endsWith("source.ts");
if (isMain) {
  const mi = process.argv.indexOf("--metro");
  const only = mi >= 0 ? process.argv[mi + 1] : undefined;
  sourceAll(only)
    .then((rs) => {
      for (const r of rs)
        console.log(
          `[source] ${r.metro}: found ${r.found}, added ${r.added} new | ${r.calls} API calls, ~$${r.estCostUsd.toFixed(3)}`
        );
    })
    .catch((e) => {
      console.error("[source] failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
