#!/bin/bash
# Slice 6 pod pipeline (ADR-006). Fetched and run by the pod's docker command;
# ALL output lands in /workspace/out/train.log (served over HTTP), and set -x
# makes every step visible so remote debugging is possible.
set -x
cd /workspace

echo "=== bootstrap $(date) ==="
command -v git || (apt-get update -qq && apt-get install -y -qq git)
nvidia-smi --query-gpu=name,memory.total --format=csv || true

echo "=== clone ==="
rm -rf repo
git clone --depth 1 https://github.com/firelever/firelever repo || { echo FAILED > /workspace/out/status.txt; exit 1; }
cd repo/finetune

echo "=== install ==="
pip install --no-cache-dir unsloth || { echo FAILED > /workspace/out/status.txt; exit 1; }

echo "=== train ==="
python train.py || { echo FAILED > /workspace/out/status.txt; exit 1; }

echo "=== export ==="
# Unsloth's output directory naming varies by version (gguf/, gguf_gguf/, …):
# find the artifact wherever it landed instead of guessing the path.
GGUF=$(find /workspace/repo/finetune -name "*.gguf" -size +1G | head -1)
[ -n "$GGUF" ] && cp "$GGUF" /workspace/out/model.gguf || { echo FAILED > /workspace/out/status.txt; exit 1; }
ls -la /workspace/out/
echo DONE > /workspace/out/status.txt
echo "=== done $(date) ==="
