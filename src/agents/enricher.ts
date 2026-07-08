import { z } from "zod";
import { extract, research } from "../llm.js";

export const Enrichment = z.object({
  company_context: z
    .string()
    .describe("2-4 sentences: what the company does, size, and operational pain points visible publicly"),
  decision_makers: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      linkedin_url: z.string().nullable(),
      email_guess: z
        .string()
        .nullable()
        .describe("Only if found publicly or inferable from a known company email pattern"),
      email_confidence: z.enum(["found_public", "pattern_guess", "unknown"]),
    })
  ),
  agent_use_case: z
    .string()
    .describe("The single most promising AI-agent use case FireLever could build for this company, grounded in the research"),
});

export async function enrich(company: string, domain: string, signal: string) {
  const notes = await research(
    "You are a B2B research analyst. Report only facts you actually found via search; mark anything inferred as inferred. Never fabricate names, emails, or URLs.",
    `Research the company "${company}" (${domain}). Context: we found this buying signal: "${signal}".

Find:
1. What the company does, rough size, and any visible operational pain points.
2. The likely decision-makers for an AI/automation consulting purchase (CEO/COO/owner for SMBs,
   VP Ops / Head of Innovation / CIO for mid-market): names, titles, LinkedIn profiles.
3. Publicly listed email addresses, or the company's email pattern (e.g. first.last@domain) if visible.
4. The single most concrete AI-agent use case a consultancy could build for them, tied to their
   actual workflows — not generic.`
  );

  return extract(
    Enrichment,
    "enrichment",
    "Extract the enrichment data from this research. For email_confidence: 'found_public' only if the address itself was found; 'pattern_guess' if constructed from a known pattern; otherwise 'unknown' with email_guess null.",
    notes
  );
}
