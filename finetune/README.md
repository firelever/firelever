# Slice 6: triage classifier fine-tune (ADR-006)

Teacher-student distillation: the production Opus classifier labels synthetic emails;
Qwen2.5-7B-Instruct learns to mimic it; the benchmark compares both against the
human-labeled golden set (evals/triage.jsonl), which no model trained on.

## 1. Generate + label the corpus (local, API)

```sh
npm run corpus     # writes corpus-raw.jsonl, corpus.jsonl, train.jsonl, val.jsonl
```

## 2. Train on RunPod (~1 GPU-hour)

1. runpod.io → Deploy a Pod → any 24GB+ card (RTX 4090 / A5000 / L4 tier is plenty),
   PyTorch template, 50GB volume.
2. Upload `finetune/train.jsonl`, `finetune/val.jsonl`, `finetune/train.py`
   (runpodctl send, or the Jupyter file browser).
3. In the pod terminal:
   ```sh
   pip install unsloth
   python train.py
   ```
4. Download `gguf/unsloth.Q4_K_M.gguf` (~4.5GB), then **stop the pod** (billing is
   per-hour while running).

## 3. Serve locally (Apple Silicon, free)

```sh
ollama create firelever-triage -f Modelfile   # Modelfile in this directory
ollama run firelever-triage
```

## 4. Benchmark

```sh
npm run eval:triage                    # teacher (Opus) on the golden set
STUDENT_URL=http://localhost:11434 npm run eval:triage:student
```

Reports accuracy, latency, and cost per 1,000 emails for teacher vs. student vs.
keyword baseline. The writeup lives in docs/ once numbers exist.
