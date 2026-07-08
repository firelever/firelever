// Tenant management:
//   npm run tenant -- create acme-freight "Acme Freight"
//   npm run tenant -- list
import { createTenant, listTenants } from "./auth.js";

const [cmd, id, name] = process.argv.slice(2);

if (cmd === "create" && id && name) {
  const { tenant, apiKey } = createTenant(id, name);
  console.log(`Tenant created: ${tenant.id} (${tenant.name})`);
  console.log(`API key (shown once, store it now): ${apiKey}`);
} else if (cmd === "list") {
  for (const t of listTenants()) console.log(`${t.id}\t${t.name}\t${t.created_at}`);
} else {
  console.error('Usage: npm run tenant -- create <slug> "<Name>"  |  npm run tenant -- list');
  process.exit(1);
}
