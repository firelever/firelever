// Triage classification eval (targets in docs/03; golden set is SYNTHETIC for now,
// see ADR-004 — replace with real labeled traffic as it arrives).
//   npm run eval:triage
// Reports model accuracy vs a keyword-rule baseline; fails under 90% or if the
// model doesn't beat the baseline.
import fs from "fs";
import path from "path";
import { classifyEmail, CATEGORIES } from "./engine.js";

const GOLDEN = path.join(process.cwd(), "evals", "triage.jsonl");
const HISTORY = path.join(process.cwd(), "evals", "history-triage.jsonl");
const TARGET = 0.9;

interface Entry {
  from: string;
  subject: string;
  body: string;
  category: (typeof CATEGORIES)[number];
}

// The baseline to beat: the kind of keyword rules a non-AI triage would use.
function keywordBaseline(e: Entry): string {
  const t = `${e.subject}\n${e.body}`.toLowerCase();
  if (/unsubscribe|opt out|webinar|% off|final hours|register free|pre-approved/.test(t))
    return "newsletter_spam";
  if (/resume|internship|recruiter|opportunity.*base|hiring|job/.test(t)) return "recruiting";
  if (/partnership|reseller|sponsor|white-label|demo|our (api|platform|program)/.test(t))
    return "vendor_partner";
  if (/invoice|w-9|kickoff|dashboard|broken|bug|re:/.test(t)) return "support";
  if (/consulting|rates|audit|help with|services|engagement|build/.test(t))
    return "new_business";
  return "other";
}

async function main() {
  const golden: Entry[] = fs
    .readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  let modelHits = 0;
  let baselineHits = 0;
  const misses: string[] = [];

  // Small batches: parallel enough to be fast, polite to rate limits.
  const BATCH = 4;
  for (let i = 0; i < golden.length; i += BATCH) {
    const batch = golden.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((g) => classifyEmail(g.from, g.subject, g.body))
    );
    batch.forEach((g, j) => {
      const predicted = results[j].category;
      if (predicted === g.category) modelHits++;
      else misses.push(`  expected ${g.category}, got ${predicted}: ${g.subject}`);
      if (keywordBaseline(g) === g.category) baselineHits++;
      console.log(
        `${predicted === g.category ? "✓" : "✗"} ${predicted.padEnd(15)} (truth: ${g.category})  ${g.subject}`
      );
    });
  }

  const accuracy = modelHits / golden.length;
  const baseline = baselineHits / golden.length;
  console.log(`\nTriage eval — ${golden.length} emails (SYNTHETIC golden set)`);
  console.log(`model accuracy     ${(accuracy * 100).toFixed(1)}%  (target ≥ ${TARGET * 100}%)`);
  console.log(`keyword baseline   ${(baseline * 100).toFixed(1)}%`);
  if (misses.length) console.log(`\nMisses:\n${misses.join("\n")}`);

  fs.appendFileSync(
    HISTORY,
    JSON.stringify({
      at: new Date().toISOString(),
      n: golden.length,
      synthetic: true,
      accuracy,
      baseline_accuracy: baseline,
    }) + "\n"
  );

  const pass = accuracy >= TARGET && accuracy > baseline;
  console.log(`\n${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
