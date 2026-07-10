// Contract redlines (Levi L5): Claude reviews a contract from the knowledge base
// and proposes clause-level changes with a concern and suggested wording. A real
// AI feature over the existing docs stack, structured for the Contract window.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, withDeadline } from "../llm.js";
import { MODEL } from "../config.js";
import db from "./store.js";

const RedlineSchema = z.object({
  document: z.string().describe("the source document filename"),
  redlines: z
    .array(
      z.object({
        clause: z.string().describe("clause reference or short heading, e.g. 'Section 8 — Financing'"),
        concern: z.string().describe("one sentence: why this clause is worth changing (risk/ambiguity)"),
        old_text: z.string().describe("the current wording, quoted from the contract"),
        suggested_text: z.string().describe("proposed replacement wording"),
      })
    )
    .describe("2-5 of the most material redlines; empty if the contract is clean"),
});
export type RedlineResult = z.infer<typeof RedlineSchema>;

// Pick the tenant's likeliest contract: the most recently ingested doc whose text
// looks contract-like, else the most recent doc.
function pickContract(tenantId: string): { path: string; text: string } | null {
  const docs = db
    .prepare(
      `SELECT d.id, d.path,
              (SELECT group_concat(c.text, '\n\n') FROM chunks c WHERE c.document_id = d.id) AS text
       FROM documents d WHERE d.tenant_id = ? ORDER BY d.ingested_at DESC`
    )
    .all(tenantId) as { id: number; path: string; text: string | null }[];
  if (docs.length === 0) return null;
  const contractish = docs.find((d) => /contract|agreement|msa|nda|lease|terms/i.test(d.path) && d.text);
  const chosen = contractish ?? docs.find((d) => d.text) ?? null;
  return chosen && chosen.text ? { path: chosen.path, text: chosen.text } : null;
}

export async function proposeRedlines(tenantId: string): Promise<RedlineResult | null> {
  const doc = pickContract(tenantId);
  if (!doc) return null;
  const body = doc.text.slice(0, 60000); // cap for cost; contracts fit comfortably
  const response = await withDeadline("redlines", (signal) =>
    client.messages.parse(
      {
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system:
          "You are a careful contracts reviewer. Propose the most material redlines a buyer's counsel would raise: " +
          "ambiguous terms, missing protections, one-sided clauses, blank fields. Quote current wording exactly for old_text. " +
          "Some text may be OCR'd from a scan and contain transcription errors — do not flag likely OCR noise as a drafting issue. " +
          "Be concrete and conservative; only real, defensible concerns.",
        messages: [
          {
            role: "user",
            content: `Review this contract (${doc.path.replace(/^uploads\//, "")}) and propose redlines.\n\n<contract>\n${body}\n</contract>`,
          },
        ],
        output_config: { format: zodOutputFormat(RedlineSchema) },
      },
      { signal }
    )
  );
  return response.parsed_output ?? { document: doc.path, redlines: [] };
}
