// Browser voice capture: records one spoken utterance with live level metering
// (feeds the orb) and auto-stops on silence. The blob is sent to /api/voice.

export interface RecordHandle {
  stop: () => void; // manual stop (mic tapped again)
}

// Records until ~1.3s of silence after speech, or 15s max. Calls onLevel every
// frame with a 0-1 mic level for the orb. Resolves with the recorded audio.
export function recordUtterance(
  onLevel: (level: number) => void,
  onReady: (h: RecordHandle) => void
): Promise<Blob | null> {
  return new Promise(async (resolve) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      resolve(null);
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    let stopped = false;
    const cleanup = () => {
      try { ctx.close(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
    };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      rec.onstop = () => { cleanup(); resolve(chunks.length ? new Blob(chunks, { type: mime || "audio/webm" }) : null); };
      if (rec.state !== "inactive") rec.stop(); else { cleanup(); resolve(null); }
    };

    onReady({ stop: finish });
    rec.start();

    let heardSpeech = false;
    let silenceStart = 0;
    const started = performance.now();
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, Math.max(0, (rms - 0.015) * 7));
      onLevel(level);
      const now = performance.now();
      if (level > 0.12) { heardSpeech = true; silenceStart = 0; }
      else if (heardSpeech) { if (!silenceStart) silenceStart = now; else if (now - silenceStart > 1300) return finish(); }
      if (now - started > 15000) return finish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

export function playAudio(base64: string, onEnd: () => void) {
  const audio = new Audio("data:audio/mpeg;base64," + base64);
  audio.onended = onEnd;
  audio.onerror = onEnd;
  audio.play().catch(onEnd);
  return audio;
}
