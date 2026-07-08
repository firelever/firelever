// Daily pipeline: prospect -> enrich -> score -> draft.
// Nothing is ever sent from here — drafts land in the review queue (npm run review).
import { insertLead, knownDomains, leadsByStatus, updateLead } from "./db.js";
import { prospect } from "./agents/prospector.js";
import { enrich } from "./agents/enricher.js";
import { score } from "./agents/scorer.js";
import { draft } from "./agents/drafter.js";
import { SCORE_THRESHOLD } from "./config.js";

async function main() {
  if (process.argv.includes("--skip-prospect")) {
    console.log("── Prospector: skipped (--skip-prospect)\n");
  } else {
    console.log("── Prospector: searching for new leads…");
    const { prospects } = await prospect(knownDomains());
    let added = 0;
    for (const p of prospects) {
      if (insertLead(p)) added++;
    }
    console.log(`   found ${prospects.length}, ${added} new\n`);
  }

  for (const lead of leadsByStatus("new")) {
    console.log(`── Enricher: ${lead.company} (${lead.domain})`);
    try {
      const enrichment = await enrich(lead.company, lead.domain, lead.signal ?? "");
      updateLead(lead.id, {
        enrichment_json: JSON.stringify(enrichment, null, 2),
        status: "enriched",
      });
    } catch (err) {
      console.error(`   enrichment failed: ${err}`);
    }
  }

  for (const lead of leadsByStatus("enriched")) {
    console.log(`── Scorer: ${lead.company}`);
    const s = await score(lead.company, lead.signal ?? "", lead.enrichment_json ?? "{}");
    const qualified = s.score >= SCORE_THRESHOLD;
    updateLead(lead.id, {
      score: s.score,
      score_reasoning: s.reasoning,
      status: qualified ? "scored" : "parked",
    });
    console.log(`   ${s.score}/100 ${qualified ? "→ qualified" : "→ parked"}`);
  }

  for (const lead of leadsByStatus("scored")) {
    console.log(`── Drafter: ${lead.company}`);
    const sequence = await draft(lead.company, lead.signal ?? "", lead.enrichment_json ?? "{}");
    updateLead(lead.id, {
      drafts_json: JSON.stringify(sequence, null, 2),
      status: "drafted",
    });
  }

  const pending = leadsByStatus("drafted").length;
  console.log(`\nDone. ${pending} draft(s) awaiting review → npm run review`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
