// Tenant management:
//   npm run tenant -- create acme-freight "Acme Freight"
//   npm run tenant -- list
//   npm run tenant -- rekey [tenant-id]   (defaults to the docs-heaviest tenant)
import { createTenant, listTenants, rekeyTenant, topDocsTenantId } from "./auth.js";

const [cmd, id, name] = process.argv.slice(2);

if (cmd === "create" && id && name) {
  const { tenant, apiKey } = createTenant(id, name);
  console.log(`Tenant created: ${tenant.id} (${tenant.name})`);
  console.log(`API key (shown once, store it now): ${apiKey}`);
} else if (cmd === "list") {
  for (const t of listTenants()) console.log(`${t.id}\t${t.name}\t${t.created_at}`);
} else if (cmd === "rekey") {
  const target = id || topDocsTenantId();
  if (!target) {
    console.error("no tenant to rekey (pass a tenant id)");
    process.exit(1);
  }
  const { tenant, apiKey } = rekeyTenant(target);
  console.log(`Rekeyed tenant: ${tenant.id} (${tenant.name}) — the old key no longer works.`);
  console.log(`New API key (shown once, store it now): ${apiKey}`);
} else {
  console.error('Usage: npm run tenant -- create <slug> "<Name>"  |  list  |  rekey [tenant-id]');
  process.exit(1);
}
