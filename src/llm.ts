import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { MODEL } from "./config.js";

if (!process.env.ANTHROPIC_API_KEY) {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    process.loadEnvFile(envFile);
  } catch {
    // no .env — the SDK falls back to its normal credential resolution
  }
}

export const client = new Anthropic();

const WEB_TOOLS = [
  { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8 },
  { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 8 },
];

// A wedged streaming connection can otherwise hang the pipeline forever:
// abort any single API call after a hard deadline and retry once.
const CALL_DEADLINE_MS = 8 * 60 * 1000;

export async function withDeadline<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_DEADLINE_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (attempt === 2) throw err;
      console.error(`   ${label}: attempt ${attempt} failed (${err}), retrying…`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

/**
 * Run a web-research task and return the model's final text.
 * Server-side web tools can pause the turn at the iteration limit
 * (stop_reason "pause_turn") — re-send to let the server resume.
 */
export async function research(system: string, prompt: string): Promise<string> {
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const maxContinuations = 5;

  for (let i = 0; i <= maxContinuations; i++) {
    const message = await withDeadline("research", (signal) =>
      client.messages
        .stream(
          {
            model: MODEL,
            max_tokens: 32000,
            thinking: { type: "adaptive" },
            system,
            tools: WEB_TOOLS,
            messages,
          },
          { signal }
        )
        .finalMessage()
    );

    if (message.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: message.content }];
      continue;
    }

    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  throw new Error("research: exceeded max pause_turn continuations");
}

/**
 * Extract a validated object from free text using structured outputs.
 */
export async function extract<T extends z.ZodType>(
  schema: T,
  name: string,
  instruction: string,
  text: string
): Promise<z.infer<T>> {
  const response = await withDeadline(`extract(${name})`, (signal) =>
    client.messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        messages: [
          {
            role: "user",
            content: `${instruction}\n\n<source>\n${text}\n</source>`,
          },
        ],
        output_config: { format: zodOutputFormat(schema) },
      },
      { signal }
    )
  );
  if (response.parsed_output == null) {
    throw new Error(`extract(${name}): model output did not match schema`);
  }
  return response.parsed_output;
}
