// RunPod orchestration for the slice 6 training run (ADR-006).
//   npm run gpu -- launch     # create a pod that clones the repo, trains, serves results
//   npm run gpu -- status     # pod state + training log tail
//   npm run gpu -- fetch      # download the trained GGUF once ready
//   npm run gpu -- kill       # terminate the pod (stops billing)
// The pod runs unattended: clone → pip install → train → copy GGUF + log to a
// tiny HTTP server we poll from here. Nothing interactive on the GPU side.
import fs from "fs";
import path from "path";
import "../config.js"; // loads .env

const API = "https://api.runpod.io/graphql";
const KEY = process.env.RUNPOD_API_KEY;
if (!KEY) {
  console.error("RUNPOD_API_KEY missing from .env");
  process.exit(1);
}
const STATE = path.join(process.cwd(), "finetune", ".pod.json");

const REPO = "https://github.com/firelever/firelever";
const IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
const GPU = "NVIDIA GeForce RTX 4090";

// Startup: everything logged into the served directory so progress is pollable
// from outside. status.txt appears only when the whole pipeline finished.
const START_CMD = [
  "bash -c '",
  "mkdir -p /workspace/out && cd /workspace/out && nohup python -m http.server 8000 >/dev/null 2>&1 & ",
  "cd /workspace && git clone --depth 1 " + REPO + " repo >> /workspace/out/train.log 2>&1 && ",
  "cd repo/finetune && pip install unsloth >> /workspace/out/train.log 2>&1 && ",
  "python train.py >> /workspace/out/train.log 2>&1 && ",
  "cp gguf/*.gguf /workspace/out/model.gguf && echo DONE > /workspace/out/status.txt || echo FAILED > /workspace/out/status.txt; ",
  "sleep infinity'",
].join("");

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as any;
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function podId(): string {
  if (!fs.existsSync(STATE)) {
    console.error("No pod recorded. Run: npm run gpu -- launch");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(STATE, "utf8")).id;
}

function proxyUrl(id: string, file: string) {
  return `https://${id}-8000.proxy.runpod.net/${file}`;
}

async function launch() {
  const data = await gql(
    `mutation Deploy($input: PodFindAndDeployOnDemandInput) {
       podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr }
     }`,
    {
      input: {
        cloudType: "COMMUNITY",
        gpuCount: 1,
        gpuTypeId: GPU,
        name: "firelever-triage-lora",
        imageName: IMAGE,
        dockerArgs: START_CMD,
        containerDiskInGb: 80,
        volumeInGb: 0,
        minVcpuCount: 4,
        minMemoryInGb: 16,
        ports: "8000/http",
        env: [],
      },
    }
  );
  const pod = data.podFindAndDeployOnDemand;
  fs.writeFileSync(STATE, JSON.stringify(pod, null, 2));
  console.log(`Pod launched: ${pod.id} on ${GPU} at $${pod.costPerHr}/hr`);
  console.log("Poll with: npm run gpu -- status");
}

async function status() {
  const id = podId();
  const data = await gql(
    `query Pod($id: String!) { pod(input: {podId: $id}) {
       id desiredStatus runtime { uptimeInSeconds }
     } }`,
    { id }
  );
  const pod = data.pod;
  if (!pod) return console.log("Pod no longer exists (terminated).");
  const up = pod.runtime?.uptimeInSeconds ?? 0;
  console.log(`Pod ${pod.id}: ${pod.desiredStatus}, uptime ${Math.round(up / 60)}m`);

  for (const f of ["status.txt", "train.log"]) {
    try {
      const res = await fetch(proxyUrl(id, f));
      if (res.ok) {
        const text = await res.text();
        if (f === "status.txt") console.log(`status.txt: ${text.trim()}`);
        else console.log("--- train.log (last 15 lines) ---\n" + text.trim().split("\n").slice(-15).join("\n"));
      } else if (f === "status.txt") {
        console.log("status.txt: not yet (still installing or training)");
      }
    } catch {
      console.log(`${f}: HTTP proxy not reachable yet`);
    }
  }
}

async function fetchModel() {
  const id = podId();
  const url = proxyUrl(id, "model.gguf");
  const out = path.join(process.cwd(), "finetune", "unsloth.Q4_K_M.gguf");
  console.log(`Downloading ${url} → ${out} (several GB, be patient)…`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const ws = fs.createWriteStream(out);
  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ws.write(value);
    bytes += value.length;
    if (bytes % (256 * 1024 * 1024) < value.length) {
      console.log(`  ${(bytes / 1e9).toFixed(2)} GB`);
    }
  }
  ws.end();
  console.log(`Done: ${(bytes / 1e9).toFixed(2)} GB. Now: npm run gpu -- kill`);
}

async function kill() {
  const id = podId();
  await gql(`mutation Kill($id: String!) { podTerminate(input: {podId: $id}) }`, { id });
  fs.unlinkSync(STATE);
  console.log(`Pod ${id} terminated. Billing stopped.`);
}

const cmd = process.argv[2];
const actions: Record<string, () => Promise<void>> = { launch, status, fetch: fetchModel, kill };
if (!actions[cmd]) {
  console.error("Usage: npm run gpu -- launch | status | fetch | kill");
  process.exit(1);
}
actions[cmd]().catch((e) => {
  console.error(e);
  process.exit(1);
});
