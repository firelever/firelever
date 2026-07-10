// Voice pipeline (Levi L3, ADR-013): Deepgram speech-to-text → Claude (existing
// answer path) → ElevenLabs text-to-speech. Keys stay server-side; the browser
// only sends mic audio and receives the transcript, answer, and spoken reply.

const DEEPGRAM_KEY = () => process.env.DEEPGRAM_API_KEY ?? "";
const ELEVEN_KEY = () => process.env.ELEVENLABS_API_KEY ?? "";
// Default voice: Liam (premade, usable on free tier — steady, even narrator).
// Override with ELEVENLABS_VOICE_ID.
const ELEVEN_VOICE = () => process.env.ELEVENLABS_VOICE_ID ?? "TX3LPaxmHKxFdv7VOQHJ";
const ELEVEN_MODEL = () => process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";

export function voiceConfigured(): boolean {
  return !!DEEPGRAM_KEY() && !!ELEVEN_KEY();
}

// Transcribe an audio blob (webm/opus from the browser) via Deepgram.
export async function transcribe(audio: ArrayBuffer, contentType: string): Promise<string> {
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true", {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_KEY()}`, "Content-Type": contentType || "audio/webm" },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}

// Synthesize speech for the answer text via ElevenLabs; returns mp3 bytes.
export async function synthesize(text: string): Promise<Buffer> {
  // Keep spoken replies snappy — long answers are read from the screen.
  const spoken = text.replace(/\[\d+\]/g, "").slice(0, 900);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE()}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({
      text: spoken,
      model_id: ELEVEN_MODEL(),
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.15 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
