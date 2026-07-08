// Benchmark the fine-tuned student on the human-labeled golden set (ADR-006).
//   npm run eval:student
// Same 24 emails as the teacher's eval (evals/triage.jsonl) — neither model has
// trained on them. Reports accuracy, mean latency, and cost per 1,000 emails,
// appending to evals/history-triage.jsonl with model provenance.
import fs from "fs";
import path from "path";
import { STUDENT_SYSTEM } from "./student-prompt.js";
import { CATEGORIES } from "../triage/engine.js";

const OLLAMA = process.env.STUDENT_URL ?? "http://localhost:11434";
const MODEL = process.env.STUDENT_MODEL ?? "firelever-triage";
const GOLDEN = path.join(process.cwd(), "evals", "triage.jsonl");
const HISTORY = path.join(process.cwd(), "evals", "history-triage.jsonl");

interface Entry {
  from: string;
  subject: string;
  body: string;
  category: (typeof CATEGORIES)[number];
}

async function classify(e: Entry): Promise<{ category: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: STUDENT_SYSTEM },
        { role: "user", content: `From: ${e.from}\nSubject: ${e.subject}\n\n${e.body}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  const ms = Date.now() - t0;
  const text: string = data.message?.content ?? "";
  // The student was trained to emit bare JSON; parse defensively anyway.
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? "{}");
    return { category: parsed.category ?? "PARSE_FAIL", ms };
  } catch {
    return { category: "PARSE_FAIL", ms };
  }
}

async function main() {
  const golden: Entry[] = fs
    .readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  let hits = 0;
  const latencies: number[] = [];
  for (const g of golden) {
    const { category, ms } = await classify(g);
    latencies.push(ms);
    const ok = category === g.category;
    if (ok) hits++;
    console.log(`${ok ? "✓" : "✗"} ${category.padEnd(15)} (truth: ${g.category}) ${ms}ms  ${g.subject}`);
  }

  const accuracy = hits / golden.length;
  const meanMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`\nStudent (${MODEL} via Ollama) on ${golden.length} human-labeled emails:`);
  console.log(`accuracy      ${(accuracy * 100).toFixed(1)}%`);
  console.log(`mean latency  ${Math.round(meanMs)}ms/email (local Apple Silicon)`);
  console.log(`cost          $0 marginal (local) — teacher reference: ~$5 per 1,000 emails`);

  fs.appendFileSync(
    HISTORY,
    JSON.stringify({
      at: new Date().toISOString(),
      model: `student:${MODEL}`,
      n: golden.length,
      synthetic: true,
      accuracy,
      mean_latency_ms: Math.round(meanMs),
    }) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
