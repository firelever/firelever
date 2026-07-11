// Inspect, seed, or prune tenant memories:
//   npm run memory -- list <tenant-id>
//   npm run memory -- add <tenant-id> "The buyer entity is BDLP Enterprises LLC..."
//   npm run memory -- remove <tenant-id> <substring>
import db from "./store.js";
import { addMemory, listMemories } from "./memory.js";

const [cmd, tenant, ...rest] = process.argv.slice(2);
if (cmd === "list" && tenant) {
  const notes = listMemories(tenant, 100);
  if (!notes.length) console.log("(no memories)");
  notes.forEach((n, i) => console.log(`${i + 1}. ${n}`));
} else if (cmd === "add" && tenant && rest.length) {
  addMemory(tenant, rest.join(" "));
  console.log("remembered.");
} else if (cmd === "remove" && tenant && rest.length) {
  const needle = `%${rest.join(" ")}%`;
  const res = db.prepare(`DELETE FROM tenant_memories WHERE tenant_id = ? AND note LIKE ?`).run(tenant, needle);
  console.log(`removed ${res.changes} memor${res.changes === 1 ? "y" : "ies"}.`);
} else {
  console.error('Usage: npm run memory -- list <tenant> | add <tenant> "<note>" | remove <tenant> <substring>');
  process.exit(1);
}
