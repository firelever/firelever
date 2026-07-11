// Kokoro TTS (Apache-2.0, hexgrad/Kokoro-82M): natural open-source voice that
// runs fully in the browser — no key, no quota, no server load. The ~80MB model
// downloads once (transformers.js caches it), then replies synthesize locally.
// Used as Levi's free voice; ElevenLabs Liam takes over when quota allows.
import type { KokoroTTS } from "kokoro-js";

const VOICE = "am_liam"; // Kokoro's own Liam — close cousin of the ElevenLabs voice

let ttsPromise: Promise<KokoroTTS> | null = null;
let ready = false;

export function kokoroReady(): boolean {
  return ready;
}

// Kick off the model download/load; safe to call repeatedly.
export function loadKokoro(onProgress?: (pct: number) => void): Promise<KokoroTTS> {
  ttsPromise ??= (async () => {
    // Dynamic import keeps kokoro-js (and transformers.js, ~1MB gz) out of the
    // main bundle — it loads only when voice actually starts. q8 on wasm is the
    // reliable, small (~92MB) configuration; quality is close to full precision.
    const { KokoroTTS } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p: any) => {
        if (onProgress && p.status === "progress" && p.total) onProgress(Math.round((p.loaded / p.total) * 100));
      },
    });
    ready = true;
    return tts;
  })();
  return ttsPromise;
}

// Synthesize text to a playable WAV blob URL. Throws if the model fails.
export async function kokoroSpeak(text: string): Promise<string> {
  const tts = await loadKokoro();
  const audio = await tts.generate(text, { voice: VOICE });
  return URL.createObjectURL(audio.toBlob());
}

// Streaming synthesis: emits a playable blob URL per sentence as soon as it's
// ready, so playback starts after the first sentence (~1s) instead of after
// the whole answer. isCancelled() lets barge-in abandon the rest.
export async function kokoroStreamSpeak(
  text: string,
  onChunk: (url: string) => void,
  isCancelled: () => boolean
): Promise<void> {
  const tts = await loadKokoro();
  for await (const { audio } of tts.stream(text, { voice: VOICE })) {
    if (isCancelled()) return;
    onChunk(URL.createObjectURL(audio.toBlob()));
  }
}
