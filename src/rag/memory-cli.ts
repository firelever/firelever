// Inspect or seed tenant memories:
//   npm run memory -- list <tenant-id>
//   npm run memory -- add <tenant-id> "The buyer entity is BDLP Enterprises LLC..."
import { addMemory, listMemories } from "./memory.js";

const [cmd, tenant, ...rest] = process.argv.slice(2);
if (cmd === "list" && tenant) {
  const notes = listMemories(tenant, 100);
  if (!notes.length) console.log("(no memories)");
  notes.forEach((n, i) => console.log(`${i + 1}. ${n}`));
} else if (cmd === "add" && tenant && rest.length) {
  addMemory(tenant, rest.join(" "));
  console.log("remembered.");
} else {
  console.error('Usage: npm run memory -- list <tenant> | add <tenant> "<note>"');
  process.exit(1);
}
