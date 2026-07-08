# ADR-006: Fine-tune via teacher-student distillation on synthetic email

**Status:** Accepted 2026-07-08 · **Slice:** 6 · **Deciders:** Peter + Claude

## Context

Slice 6 (PRD S3): fine-tune a small model on one narrow capability and benchmark it
against the API baseline. The chosen capability is triage classification. The original
plan (train on accumulated human review verdicts) is blocked: the inbox is weeks old
and has produced ~15 real emails, none a labeled training set.

## Decisions

1. **Task: full triage classification** — `{category, needs_reply, urgency}` — so the
   student is a drop-in replacement for the production classifier, not a toy subtask.
2. **Teacher-student distillation.** Generate diverse synthetic inbound emails, label
   them with the production Opus classifier (the teacher, same prompt as production),
   and train the student to reproduce the teacher's labels. Honest framing: the
   student's ceiling is the teacher; the question the benchmark answers is how close a
   local 7B gets at a fraction of the cost and latency.
3. **Contamination control.** The evaluation set is the existing human-labeled golden
   set (evals/triage.jsonl) plus real labeled emails as they accumulate. The corpus
   generator never sees golden-set emails, and generation prompts use different
   scenario seeds (industries, personas, tones) than the golden set's. Train and eval
   are also disjoint by construction (generated vs. hand-written).
4. **Student: Qwen2.5-7B-Instruct + LoRA (Unsloth), exported to GGUF** so the
   benchmark runs on Apple Silicon via Ollama — zero-cost inference, and "runs on
   hardware an SMB already owns" is part of the pitch. Training on a RunPod hourly
   pod (mid-tier GPU, est. < $10); RunPod chosen because the same image can move to
   their serverless tier if the student ever serves production traffic. Fly.io GPUs
   were ruled out: deprecated July 31, 2026.
5. **Benchmark dimensions:** accuracy on the human-labeled eval set (student vs.
   teacher vs. keyword baseline), latency per email, and cost per 1,000 emails.
   The writeup ships regardless of who wins — "when to fine-tune vs. call a frontier
   model" is the deliverable.

## Consequences

- Distillation caps the student at teacher quality; if the teacher is wrong in a
  systematic way, the student inherits it. The human-labeled eval set is the check.
- Synthetic-only training data means real-world drift is unmeasured until real
  labeled traffic accumulates; the eval history records `synthetic` provenance.
- ~$10-20 total spend: corpus generation + labeling (API) and 1-2 GPU-hours.
