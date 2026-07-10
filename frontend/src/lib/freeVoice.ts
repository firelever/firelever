// Free realtime voice: the browser's Web Speech API transcribes speech for free
// (no key, no quota, Chrome/Safari). We run continuous recognition with live
// turn detection, meter the mic for the orb, and fire onUtterance per finished
// turn. The server grounds the reply and returns Liam audio. onSpeechStart lets
// the caller barge-in (stop playback) when the user talks over the reply.

export interface FreeVoiceHandlers {
  onStart: () => void;
  onSpeechStart: () => void; // user began speaking (for barge-in)
  onUtterance: (text: string) => void; // a finished spoken turn
  onLevel: (level: number) => void; // mic level 0..1 for the orb
  onError: (msg: string) => void;
  onEnd: () => void;
}

export interface FreeVoiceHandle {
  stop: () => void;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

// Free browser text-to-speech (no key, no quota). Used as the fallback when the
// nicer ElevenLabs voice is out of quota. Returns a stop() for barge-in.
export function browserSpeak(text: string, onEnd: () => void): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) {
    onEnd();
    return () => {};
  }
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    const voices = synth.getVoices();
    const preferred = voices.find(
      (v) => v.lang.startsWith("en") && /Samantha|Alex|Daniel|Aaron|Google US English/i.test(v.name)
    );
    if (preferred) u.voice = preferred;
    u.onend = onEnd;
    u.onerror = onEnd;
    synth.speak(u);
  } catch {
    onEnd();
  }
  return () => {
    try {
      synth.cancel();
    } catch {}
  };
}

export async function startFreeVoice(h: FreeVoiceHandlers): Promise<FreeVoiceHandle | null> {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) {
    h.onError("Speech recognition needs Chrome (or Safari). It isn't available in this browser.");
    return null;
  }

  // Separate mic stream just for level metering (the orb waveform).
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    h.onError("Microphone permission is needed for voice.");
    return null;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = requestAnimationFrame(function tick() {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    h.onLevel(Math.min(1, Math.max(0, (Math.sqrt(sum / buf.length) - 0.01) * 7)));
    raf = requestAnimationFrame(tick);
  });

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  let stopped = false;

  rec.onstart = () => h.onStart();
  rec.onspeechstart = () => h.onSpeechStart();
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const text = (r[0]?.transcript ?? "").trim();
        if (text) h.onUtterance(text);
      }
    }
  };
  rec.onerror = (e: any) => {
    if (e.error && e.error !== "no-speech" && e.error !== "aborted") h.onError(e.error);
  };
  // Chrome auto-stops on silence; restart to keep listening until the user ends it.
  rec.onend = () => {
    if (!stopped) {
      try {
        rec.start();
      } catch {
        /* already starting */
      }
    }
  };

  try {
    rec.start();
  } catch {
    h.onError("couldn't start voice recognition");
  }

  return {
    stop: () => {
      stopped = true;
      try {
        rec.stop();
      } catch {}
      cancelAnimationFrame(raf);
      try {
        ctx.close();
      } catch {}
      stream.getTracks().forEach((t) => t.stop());
      h.onEnd();
    },
  };
}
