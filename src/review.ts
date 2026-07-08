// Interactive review queue: approve / reject / skip each drafted sequence.
// Approved sequences are printed ready to paste into Gmail (free-tier manual sending).
import readline from "readline/promises";
import { leadsByStatus, updateLead } from "./db.js";

async function main() {
  const drafted = leadsByStatus("drafted");
  if (drafted.length === 0) {
    console.log("Review queue is empty. Run `npm run pipeline` first.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const lead of drafted) {
    const seq = JSON.parse(lead.drafts_json ?? "{}");
    console.log("\n" + "═".repeat(70));
    console.log(`${lead.company}  —  score ${lead.score}/100`);
    console.log(`Signal: ${lead.signal}`);
    console.log(`Why: ${lead.score_reasoning}`);
    console.log(`To: ${seq.to_name} (${seq.to_title}) <${seq.to_email ?? "no email found — find manually"}>`);
    for (const email of seq.emails ?? []) {
      console.log(`\n--- Day ${email.day} ---\nSubject: ${email.subject}\n\n${email.body}`);
    }
    console.log("═".repeat(70));

    const answer = (await rl.question("[a]pprove / [r]eject / [s]kip? ")).trim().toLowerCase();
    if (answer === "a") {
      updateLead(lead.id, { status: "approved" });
      console.log("Approved — copy the day-0 email into Gmail and send.");
    } else if (answer === "r") {
      updateLead(lead.id, { status: "rejected" });
      console.log("Rejected.");
    } else {
      console.log("Skipped — stays in queue.");
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
