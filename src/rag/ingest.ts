// Ingestion CLI: extract → chunk → embed → store, per tenant.
//   npm run ingest -- --tenant firelever PLAN.md README.md docs
// Directories are walked recursively for supported extensions. Re-ingesting an
// unchanged file (same content hash) is a no-op; changed files are re-chunked.
import fs from "fs";
import path from "path";
import { SUPPORTED } from "./extract.js";
import { getEmbedder } from "./embeddings.js";
import { ensureVecTable } from "./store.js";
import { ingestFile } from "./ingest-file.js";

function collectFiles(targets: string[]): { files: string[]; unsupported: string[] } {
  const files: string[] = [];
  const unsupported: string[] = [];
  const visit = (p: string) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        visit(path.join(p, entry));
      }
    } else if (SUPPORTED.includes(path.extname(p).toLowerCase())) {
      files.push(p);
    } else {
      unsupported.push(p);
    }
  };
  targets.forEach(visit);
  return { files, unsupported };
}

async function main() {
  const args = process.argv.slice(2);
  const tenantIdx = args.indexOf("--tenant");
  if (tenantIdx === -1 || !args[tenantIdx + 1] || args.length < 4) {
    console.error("Usage: npm run ingest -- --tenant <tenant-id> <file-or-dir> [...]");
    process.exit(1);
  }
  const tenantId = args[tenantIdx + 1];
  const targets = args.filter((_, i) => i !== tenantIdx && i !== tenantIdx + 1);

  const embedder = getEmbedder();
  ensureVecTable(embedder.name, embedder.dim);

  const { files, unsupported } = collectFiles(targets);
  let ingested = 0;
  let unchanged = 0;
  let totalChunks = 0;

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const result = await ingestFile(tenantId, file, rel);
    if (result.outcome === "unchanged") {
      unchanged++;
    } else if (result.outcome === "empty") {
      console.warn(`  skip (empty): ${rel}`);
    } else {
      ingested++;
      totalChunks += result.chunks;
      console.log(`  ingested: ${rel} (${result.chunks} chunks)`);
    }
  }

  console.log(
    `\nDone. tenant=${tenantId} provider=${embedder.name} ` +
      `ingested=${ingested} (${totalChunks} chunks) unchanged=${unchanged} unsupported=${unsupported.length}`
  );
  for (const u of unsupported) console.log(`  unsupported: ${path.relative(process.cwd(), u)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
