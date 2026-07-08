// Grounded Q&A eval (slice 3, targets from docs/03):
//   npm run eval:qa
// Answerable questions: judged for faithfulness (every claim supported by the
// sources) and correctness (conveys the expected fact); citations checked
// programmatically against the expected document. Unanswerable questions: the
// system must refuse. Appends results to evals/history-qa.jsonl.
import fs from "fs";
import path from "path";
import { z } from "zod";
import { extract } from "../llm.js";
import { answer, PROMPT_VERSION } from "./answer.js";

const TENANT = process.env.EVAL_TENANT ?? "firelever";
const GOLDEN = path.join(process.cwd(), "evals", "qa.jsonl");
const HISTORY = path.join(process.cwd(), "evals", "history-qa.jsonl");
const TARGET_FAITHFULNESS = 0.95;
const TARGET_REFUSAL = 0.9;

interface QaEntry {
  question: string;
  doc?: string;
  fact?: string;
  unanswerable?: boolean;
}

const JudgeSchema = z.object({
  supported: z
    .boolean()
    .describe("true only if EVERY factual claim in the answer is supported by the sources"),
  unsupported_claims: z.array(z.string()).describe("claims not backed by any source"),
  conveys_expected: z
    .boolean()
    .describe("true if the answer correctly conveys the expected fact"),
});

async function main() {
  const golden: QaEntry[] = fs
    .readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const answerable = golden.filter((g) => !g.unanswerable);
  const unanswerable = golden.filter((g) => g.unanswerable);

  // Refusal accuracy on unanswerables
  let refused = 0;
  for (const g of unanswerable) {
    const r = await answer(TENANT, g.question);
    const ok = !r.answerable;
    if (ok) refused++;
    console.log(`${ok ? "✓ refused " : "✗ ANSWERED"}  ${g.question}`);
  }

  // Faithfulness, correctness, citations on answerables
  let faithful = 0;
  let correct = 0;
  let citedRight = 0;
  let wronglyRefused = 0;
  for (const g of answerable) {
    const r = await answer(TENANT, g.question);
    if (!r.answerable) {
      wronglyRefused++;
      console.log(`✗ REFUSED   ${g.question}`);
      continue;
    }
    const citedDocs = r.cited_sources
      .map((n) => r.sources[n - 1]?.document_path ?? "")
      .filter(Boolean);
    const citeOk =
      r.cited_sources.length > 0 && (!g.doc || citedDocs.some((d) => d.endsWith(g.doc!)));
    if (citeOk) citedRight++;

    const sourceBlock = r.sources
      .map((s, i) => `[${i + 1}] ${s.document_path}\n${s.text}`)
      .join("\n\n");
    const verdict = await extract(
      JudgeSchema,
      "qa-judge",
      `You are grading a question-answering system. Question: "${g.question}". Expected fact: "${g.fact}". Judge the answer below strictly against the sources.`,
      `<sources>\n${sourceBlock}\n</sources>\n\n<answer>\n${r.answer}\n</answer>`
    );
    if (verdict.supported) faithful++;
    if (verdict.conveys_expected) correct++;
    const mark = verdict.supported && verdict.conveys_expected && citeOk ? "✓" : "✗";
    console.log(
      `${mark} faithful=${verdict.supported} correct=${verdict.conveys_expected} cite=${citeOk}  ${g.question}` +
        (verdict.unsupported_claims.length
          ? `\n    unsupported: ${verdict.unsupported_claims.join("; ")}`
          : "")
    );
  }

  const answered = answerable.length - wronglyRefused;
  const metrics = {
    at: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    refusal_accuracy: refused / unanswerable.length,
    wrongly_refused: wronglyRefused,
    faithfulness: answered ? faithful / answered : 0,
    correctness: answered ? correct / answered : 0,
    citation_accuracy: answered ? citedRight / answered : 0,
    answerable_n: answerable.length,
    unanswerable_n: unanswerable.length,
  };

  console.log(`\nQA eval — ${golden.length} questions, tenant=${TENANT}, prompt=${PROMPT_VERSION}`);
  console.log(`refusal accuracy    ${(metrics.refusal_accuracy * 100).toFixed(1)}%  (target ≥ ${TARGET_REFUSAL * 100}%)`);
  console.log(`faithfulness        ${(metrics.faithfulness * 100).toFixed(1)}%  (target ≥ ${TARGET_FAITHFULNESS * 100}%)`);
  console.log(`correctness         ${(metrics.correctness * 100).toFixed(1)}%`);
  console.log(`citation accuracy   ${(metrics.citation_accuracy * 100).toFixed(1)}%`);
  console.log(`wrongly refused     ${wronglyRefused}/${answerable.length}`);

  fs.appendFileSync(HISTORY, JSON.stringify(metrics) + "\n");

  const pass =
    metrics.refusal_accuracy >= TARGET_REFUSAL && metrics.faithfulness >= TARGET_FAITHFULNESS;
  console.log(`\n${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
