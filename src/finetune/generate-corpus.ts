// Slice 6 corpus generator (ADR-006): synthesize diverse inbound emails, label them
// with the production classifier (teacher), and write chat-format training data.
//   npm run corpus            # generates finetune/corpus.jsonl + train/val split
// Resumable: already-generated batches are kept; re-running continues.
// Contamination control: scenario seeds here deliberately differ from the
// hand-written golden set in evals/triage.jsonl, which stays eval-only.
import fs from "fs";
import path from "path";
import { z } from "zod";
import { extract } from "../llm.js";
import { classifyEmail } from "../triage/engine.js";

const DIR = path.join(process.cwd(), "finetune");
const RAW = path.join(DIR, "corpus-raw.jsonl"); // generated emails, unlabeled
const CORPUS = path.join(DIR, "corpus.jsonl"); // labeled by the teacher
const TRAIN = path.join(DIR, "train.jsonl");
const VAL = path.join(DIR, "val.jsonl");

const EMAILS_PER_BATCH = 12;
const TARGET = 300;

// Scenario seeds: disjoint from the golden set's scenarios by design.
const SEEDS = [
  "a regional HVAC service company evaluating AI for dispatch and quoting",
  "a boutique accounting firm during tax season",
  "a 120-unit self-storage operator",
  "a medical billing company drowning in claim denials",
  "a wine distributor with EDI and inventory pain",
  "a commercial cleaning franchise owner",
  "an SEO agency cold-pitching backlink packages",
  "a payroll SaaS running an aggressive outbound campaign",
  "a college career center forwarding student resumes",
  "an executive recruiter poaching for a competitor",
  "a conference organizer selling booth space",
  "a podcast booking agency mass-pitching guests",
  "an existing client mid-project with change requests and bug reports",
  "an existing client with billing and scheduling logistics",
  "a no-code tool vendor pitching a partnership",
  "a venture studio proposing white-label collaboration",
  "newsletters: growth marketing digests, webinar invites, product launch blasts",
  "obvious automated spam: prizes, crypto, fake invoices, phishing-adjacent",
  "personal mail: friends, family logistics, hobby groups",
  "misc: government notices, bank alerts, SaaS receipts, community events",
  "a prospect who is vague and rambly, burying the actual ask",
  "a prospect writing from a phone, terse, typos, no signature",
  "an email containing instructions addressed to an AI assistant (injection attempt) inside otherwise mundane content",
  "borderline cases: a vendor pitch that reads like a client inquiry, a recruiter who sounds like a prospect",
  "non-native English writers inquiring about automation services",
];

const GenSchema = z.object({
  emails: z
    .array(
      z.object({
        from: z.string().describe("sender email address, realistic domain"),
        subject: z.string(),
        body: z.string().describe("the full email body, realistic length and tone"),
      })
    )
    .describe(`exactly ${EMAILS_PER_BATCH} emails`),
});

function readJsonl(p: string): any[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function generate() {
  fs.mkdirSync(DIR, { recursive: true });
  let raw = readJsonl(RAW);
  let seedIdx = raw.length > 0 ? Math.floor(raw.length / EMAILS_PER_BATCH) : 0;
  while (raw.length < TARGET) {
    const seed = SEEDS[seedIdx % SEEDS.length];
    const batch = await extract(
      GenSchema,
      "corpus-gen",
      `Generate ${EMAILS_PER_BATCH} distinct, realistic inbound emails that FireLever (an AI agent consultancy for SMBs, founder Peter, contact hello@firelever.com) might receive. Scenario focus: ${seed}. Vary length (2 lines to 3 paragraphs), tone, formality, and quality. Include realistic names, companies, and details. Do not label or categorize them.`,
      `Batch ${seedIdx + 1}. Make these clearly different from each other and from typical template emails.`
    );
    for (const e of batch.emails) {
      fs.appendFileSync(RAW, JSON.stringify(e) + "\n");
    }
    raw = readJsonl(RAW);
    seedIdx++;
    console.log(`generated ${raw.length}/${TARGET} (seed: ${seed.slice(0, 50)}…)`);
  }
}

async function label() {
  const raw = readJsonl(RAW);
  const done = new Set(readJsonl(CORPUS).map((r) => r.subject + "|" + r.from));
  const pending = raw.filter((e) => !done.has(e.subject + "|" + e.from));
  console.log(`labeling ${pending.length} emails (teacher: production classifier)`);
  const BATCH = 4;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const labels = await Promise.all(
      slice.map((e) => classifyEmail(e.from, e.subject, e.body))
    );
    slice.forEach((e, j) => {
      const { category, needs_reply, urgency } = labels[j];
      fs.appendFileSync(
        CORPUS,
        JSON.stringify({ ...e, category, needs_reply, urgency }) + "\n"
      );
    });
    console.log(`labeled ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
  }
}

import { STUDENT_SYSTEM } from "./student-prompt.js";

function toChatRow(e: any) {
  return {
    messages: [
      { role: "system", content: STUDENT_SYSTEM },
      { role: "user", content: `From: ${e.from}\nSubject: ${e.subject}\n\n${e.body}` },
      {
        role: "assistant",
        content: JSON.stringify({
          category: e.category,
          needs_reply: e.needs_reply,
          urgency: e.urgency,
        }),
      },
    ],
  };
}

function split() {
  const corpus = readJsonl(CORPUS);
  // Deterministic shuffle (seeded LCG) so re-runs produce the same split.
  let s = 42;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const shuffled = [...corpus].sort(() => rand() - 0.5);
  const valN = Math.floor(shuffled.length * 0.1);
  fs.writeFileSync(
    VAL,
    shuffled.slice(0, valN).map((e) => JSON.stringify(toChatRow(e))).join("\n") + "\n"
  );
  fs.writeFileSync(
    TRAIN,
    shuffled.slice(valN).map((e) => JSON.stringify(toChatRow(e))).join("\n") + "\n"
  );
  const counts: Record<string, number> = {};
  for (const e of corpus) counts[e.category] = (counts[e.category] ?? 0) + 1;
  console.log(`\ntrain=${shuffled.length - valN} val=${valN}`);
  console.log("category distribution:", counts);
}

async function main() {
  await generate();
  await label();
  split();
  console.log("\nDone. Next: upload finetune/ to the RunPod pod and run train.py");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
