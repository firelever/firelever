// Ask the knowledge base a question:
//   npm run ask -- --tenant firelever "how many emails can we send per day?"
import { answer } from "./answer.js";

async function main() {
  const args = process.argv.slice(2);
  const tenantIdx = args.indexOf("--tenant");
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : undefined;
  const question = args.filter((_, i) => i !== tenantIdx && i !== tenantIdx + 1).join(" ");
  if (!tenantId || !question) {
    console.error('Usage: npm run ask -- --tenant <id> "your question"');
    process.exit(1);
  }

  const result = await answer(tenantId, question);
  if (!result.answerable) {
    console.log("I can't find this in your documents.");
    if (result.sources.length) {
      console.log("\nClosest matches (none contained the answer):");
      for (const s of result.sources.slice(0, 3)) {
        console.log(`  - ${s.document_path}${s.heading ? " › " + s.heading : ""}`);
      }
    }
    return;
  }

  console.log(result.answer);
  console.log("\nSources:");
  result.cited_sources.forEach((n) => {
    const s = result.sources[n - 1];
    if (s) console.log(`  [${n}] ${s.document_path}${s.heading ? " › " + s.heading : ""}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
