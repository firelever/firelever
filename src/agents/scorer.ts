import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, withDeadline } from "../llm.js";
import { ICP, MODEL } from "../config.js";

export const Score = z.object({
  score: z.number().int().describe("1-100 fit and timing score"),
  reasoning: z.string().describe("2-3 sentences: why this score"),
});

export async function score(
  company: string,
  signal: string,
  enrichmentJson: string
): Promise<z.infer<typeof Score>> {
  const response = await withDeadline("score", (signal_) =>
    client.messages.parse(
      {
        model: MODEL,
        max_tokens: 4096,
        system: `You score B2B leads for an AI-agent consultancy against this ICP:\n\n${ICP}\n\nScoring guide: 90+ = perfect fit with urgent timing signal and reachable decision-maker; 70-89 = strong fit, worth outreach; 40-69 = plausible but weak signal or hard to reach; <40 = poor fit. Be skeptical — a vague signal or missing decision-maker contact should cost points.`,
        messages: [
          {
            role: "user",
            content: `Company: ${company}\nSignal: ${signal}\n\nEnrichment:\n${enrichmentJson}`,
          },
        ],
        output_config: { format: zodOutputFormat(Score) },
      },
      { signal: signal_ }
    )
  );
  if (response.parsed_output == null) throw new Error("score: schema mismatch");
  return response.parsed_output;
}
