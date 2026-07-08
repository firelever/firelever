// Approval queue for drafted replies — nothing sends automatically, ever.
//   npm run triage:review [-- --tenant firelever]
// Approved replies are copy-pasted into Gmail manually (same free-tier guardrail
// as the outbound pipeline). Verdicts stay in the DB as future training data.
import readline from "readline/promises";
import { emailsByStatus, updateEmail } from "./store.js";

async function main() {
  const args = process.argv.slice(2);
  const tenantIdx = args.indexOf("--tenant");
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : "firelever";

  const drafted = emailsByStatus(tenantId, "drafted");
  if (drafted.length === 0) {
    console.log("No drafted replies to review. Run `npm run triage` first.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const e of drafted) {
    console.log("\n" + "═".repeat(70));
    console.log(`${e.category}  ·  urgency ${e.urgency}  ·  from ${e.from_addr}`);
    console.log(`Subject: ${e.subject}`);
    console.log(`Why: ${e.triage_reasoning}`);
    if (e.draft_confident === 0) {
      console.log("⚠ Drafter flagged low confidence: sources were missing key info.");
    }
    const sources = JSON.parse(e.draft_sources_json ?? "[]");
    if (sources.length) console.log(`Grounded in: ${sources.join(", ")}`);
    console.log(`\n--- Original ---\n${e.body.slice(0, 600)}${e.body.length > 600 ? "…" : ""}`);
    console.log(`\n--- Draft reply ---\n${e.draft_reply}`);
    console.log("═".repeat(70));

    const verdict = (await rl.question("[a]pprove / [r]eject / [i]gnore thread / [s]kip? "))
      .trim()
      .toLowerCase();
    if (verdict === "a") {
      updateEmail(e.id, { status: "approved" });
      console.log("Approved — copy the reply into Gmail and send.");
    } else if (verdict === "r") {
      updateEmail(e.id, { status: "rejected" });
      console.log("Rejected.");
    } else if (verdict === "i") {
      updateEmail(e.id, { status: "ignored" });
      console.log("Ignored — no reply will be sent.");
    } else {
      console.log("Skipped — stays in queue.");
    }
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
