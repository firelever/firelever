// Manual retrieval poking:
//   npm run search -- --tenant firelever "how many emails per day" [--method keyword|vector|hybrid]
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const tenantId = flag("--tenant");
  const method = (flag("--method") ?? "hybrid") as "keyword" | "vector" | "hybrid";
  const query = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true).pop();
  if (!tenantId || !query) {
    console.error('Usage: npm run search -- --tenant <id> "your question" [--method hybrid]');
    process.exit(1);
  }
  const hits = await search(tenantId, query, 5, getEmbedder(), method);
  for (const [i, h] of hits.entries()) {
    console.log(`\n#${i + 1} [${h.score.toFixed(4)}] ${h.document_path}${h.heading ? " › " + h.heading : ""}`);
    console.log(h.text.slice(0, 300).replace(/\n/g, " ") + (h.text.length > 300 ? "…" : ""));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
