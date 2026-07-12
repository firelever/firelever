// Live realtime voice via ElevenLabs Conversational AI. ElevenLabs owns the
// voice loop (streaming STT, turn-taking, barge-in, TTS); our server is the
// agent's Custom LLM, so replies stay grounded in the tenant's documents.
// The browser connects with a short-lived token minted by /api/convai/token.
import { Conversation } from "@elevenlabs/client";
import { api } from "./api";

export type LiveStatus = "connecting" | "connected" | "disconnected";
export type LiveMode = "listening" | "speaking";

export interface LiveHandlers {
  onStatus: (s: LiveStatus) => void;
  onMode: (m: LiveMode) => void;
  onMessage: (role: "user" | "agent", text: string) => void;
  onError: (msg: string) => void;
}

export interface LiveConvo {
  endSession: () => Promise<void>;
  getInputVolume: () => number;
  getOutputVolume: () => number;
}

// Opens the mic, connects to the agent, and wires callbacks. Resolves once the
// session object exists (connection continues via the callbacks).
export async function startLive(h: LiveHandlers): Promise<LiveConvo> {
  const { token, greeting } = await api.convaiToken();
  const convo = await Conversation.startSession({
    conversationToken: token,
    connectionType: "webrtc",
    // Server-built greeting: fresh every session (name, time of day, one true
    // hook from live state) instead of the agent's canned first message.
    ...(greeting ? { overrides: { agent: { firstMessage: greeting } } } : {}),
    onConnect: () => h.onStatus("connected"),
    onDisconnect: () => h.onStatus("disconnected"),
    onError: (msg) => h.onError(msg),
    onStatusChange: ({ status }) => {
      if (status === "connecting") h.onStatus("connecting");
      if (status === "disconnected") h.onStatus("disconnected");
    },
    onModeChange: ({ mode }) => h.onMode(mode),
    onMessage: ({ message, role }) => h.onMessage(role === "user" ? "user" : "agent", message),
  });
  return convo as unknown as LiveConvo;
}
