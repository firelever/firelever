import { z } from "zod";
import { extract, research } from "../llm.js";
import { ICP, PROSPECTS_PER_RUN } from "../config.js";

export const ProspectList = z.object({
  prospects: z.array(
    z.object({
      company: z.string(),
      domain: z.string().describe("Primary website domain, e.g. acme.com"),
      industry: z.string(),
      signal: z.string().describe("The specific buying signal found, with dates/specifics"),
      source_url: z.string().describe("URL where the signal was found"),
    })
  ),
});

export async function prospect(excludeDomains: string[]): Promise<z.infer<typeof ProspectList>> {
  const exclusions =
    excludeDomains.length > 0
      ? `\n\nAlready in our pipeline — do NOT include these domains:\n${excludeDomains.join(", ")}`
      : "";

  const notes = await research(
    "You are a B2B prospect researcher for an AI-agent consultancy. You only report companies and signals you actually found via search — never invent companies, URLs, or signals.",
    `Find ${PROSPECTS_PER_RUN} companies that match this ideal customer profile, each with a
concrete, verifiable buying signal found in the last ~6 months:

${ICP}

Search for signals like: recent job postings mentioning manual processes or automation,
funding/expansion news in these industries, executives posting about AI adoption.
For each company report: name, website domain, industry, the specific signal (quote or
paraphrase it, with a date if available), and the URL where you found it.${exclusions}`
  );

  return extract(
    ProspectList,
    "prospect_list",
    "Extract the list of prospect companies from this research. Only include companies with a real domain and a source URL.",
    notes
  );
}
