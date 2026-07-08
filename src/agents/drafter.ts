import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, withDeadline } from "../llm.js";
import { FIRELEVER_PITCH, MODEL } from "../config.js";

export const Sequence = z.object({
  to_name: z.string(),
  to_title: z.string(),
  to_email: z.string().nullable(),
  emails: z.array(
    z.object({
      day: z.number().int().describe("Send day relative to first email: 0, 3, 7"),
      subject: z.string(),
      body: z.string(),
    })
  ),
});

export async function draft(
  company: string,
  signal: string,
  enrichmentJson: string
): Promise<z.infer<typeof Sequence>> {
  const response = await withDeadline("draft", (abortSignal) =>
    client.messages.parse(
      {
        model: MODEL,
        max_tokens: 8000,
    system: `You write cold outreach for FireLever:\n\n${FIRELEVER_PITCH}\n\nRules:
- Write to the single best decision-maker from the enrichment data.
- 3 emails: day 0 (the pitch), day 3 (short value-add follow-up), day 7 (polite breakup).
- Every personalization claim must come from the enrichment data — never invent facts about them.
- Lead with THEIR situation (the signal, the use case), not with FireLever.
- Reference the concrete agent use case FireLever could build for them.
- Include the proof point naturally: this outreach was researched and drafted by the same kind of agent system.
- CTA: a 20-minute call. Conversational, no buzzwords, no "I hope this finds you well".
- Never use em dashes or en dashes (— or –) anywhere; restructure with commas, periods, or colons. They read as AI-written.
- Under 120 words per email. Sign as Peter, Founder, FireLever.`,
    messages: [
      {
        role: "user",
        content: `Company: ${company}\nSignal: ${signal}\n\nEnrichment:\n${enrichmentJson}`,
      },
    ],
        output_config: { format: zodOutputFormat(Sequence) },
      },
      { signal: abortSignal }
    )
  );
  if (response.parsed_output == null) throw new Error("draft: schema mismatch");
  return response.parsed_output;
}
