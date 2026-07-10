import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { applyTheme, THEME_ORDER, THEMES, ThemeName } from "./theme";
import { Icon } from "./lib/icons";
import { WINDOWS } from "./lib/windows";
import { windowContent } from "./lib/windowContent";
import { Orb, OrbMode } from "./components/Orb";
import { api, AskResult, getKey, setKey } from "./lib/api";

interface Msg { role: "user" | "bot"; text: string; cite?: string }
interface Draft { id: number; from: string; subject: string; category: string; urgency: string; draft: string; confident: boolean; grounded_in: string[]; attachments: string[] }

const FLAME = "M153.16 245.75C140.05 258.89 128.61 270.53 127.74 271.64C124.49 275.75 121.05 281.38 119.09 285.79C112.95 299.64 111.66 315.12 115.45 329.59C119.42 344.75 129.08 358.26 142.21 367.03C150.86 372.81 159.60 376.14 170.16 377.68C174.54 378.32 183.90 378.26 188.40 377.56C209.35 374.31 227.52 361.22 237.05 342.50C246.73 323.53 246.54 301.11 236.56 282.10C232.61 274.57 230.40 271.83 219.47 260.85C211.47 252.81 210.16 251.59 209.54 251.58C208.92 251.57 207.22 253.21 194.80 265.73C184.53 276.10 180.63 279.89 180.24 279.89C179.95 279.89 179.50 279.68 179.24 279.42C178.77 278.95 178.77 278.63 178.77 250.78L178.77 222.61L178.24 222.24C177.96 222.04 177.56 221.88 177.36 221.88C177.16 221.88 166.27 232.62 153.16 245.75Z";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [tenant, setTenant] = useState("");
  const [theme, setTheme] = useState<ThemeName>("ember");
  const [order, setOrder] = useState<string[]>(WINDOWS.map((w) => w.id));
  const active = order[0];
  const [nav, setNav] = useState("chat");
  const [auto, setAuto] = useState(false);
  const [mic, setMic] = useState(false);
  const [now, setNow] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [liveAnswer, setLiveAnswer] = useState<AskResult | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [queue, setQueue] = useState<Draft[]>([]);
  const [mode, setMode] = useState<OrbMode>("muted");
  const [level] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => { setMode((m) => (busy ? m : mic ? "listening" : "muted")); }, [mic, busy]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); inputRef.current?.focus(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Validate the stored key on load.
  useEffect(() => {
    if (!getKey()) { setAuthed(false); return; }
    api.me().then((m) => { setTenant(m.name); setAuthed(true); loadTriage(); }).catch(() => setAuthed(false));
  }, []);

  const connect = async () => {
    setKey(keyInput);
    try { const m = await api.me(); setTenant(m.name); setAuthed(true); loadTriage(); }
    catch { setAuthed(false); }
  };

  const loadTriage = () => api.triage().then((r) => setQueue(r.queue)).catch(() => {});

  const promote = (id: string) => setOrder((o) => [id, ...o.filter((x) => x !== id)]);

  async function submitAsk(q: string) {
    if (!q.trim() || busy) return;
    setInput("");
    setBusy(true);
    setMode("thinking");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLastQuestion(q);
    promote("answer");
    try {
      const r = await api.ask(q);
      setLiveAnswer(r);
      const cite = r.citations[0];
      setMode("responding");
      setMessages((m) => [
        ...m,
        { role: "bot", text: r.answerable ? r.answer : "I can't find this in your documents. Try uploading whatever covers it, then ask again.", cite: cite ? `${cite.document.replace(/^uploads\//, "")}${cite.heading ? " · " + cite.heading : ""}` : undefined },
      ]);
      setTimeout(() => setMode(mic ? "listening" : "muted"), 2200);
    } catch (e) {
      setMessages((m) => [...m, { role: "bot", text: "Error: " + (e instanceof Error ? e.message : e) }]);
      setMode(mic ? "listening" : "muted");
    } finally {
      setBusy(false);
    }
  }

  async function verdict(id: number, v: "approved" | "rejected" | "ignored") {
    await api.verdict(id, v).catch(() => {});
    loadTriage();
  }

  const rankStyle = useMemo(() => (id: string) => {
    const rank = order.indexOf(id);
    if (rank === 0) return { transform: "translateZ(0)", opacity: 1, filter: "none", zIndex: 20 };
    if (rank <= 2) return { transform: `translate(0, ${rank * 60}px) translateZ(-${rank * 40}px)`, opacity: 0.6 - rank * 0.12, filter: `blur(${0.4 + rank}px)`, zIndex: 20 - rank };
    if (rank <= 4) return { transform: `translate(0, ${120 + rank * 12}px) translateZ(-${140 * rank}px)`, opacity: 0.16, filter: `blur(${0.4 + rank}px)`, zIndex: 20 - rank };
    return { opacity: 0, pointerEvents: "none" as const };
  }, [order]);

  const suggestions = ["What are our net payment terms?", "Who represents the seller?", "What's in my inbox?", "What needs a reply?", "Summarize the contract"];

  // Live-data window bodies for the wired windows; static previews for the rest.
  function renderWindow(id: string): ReactNode {
    if (id === "answer") {
      if (busy && !liveAnswer) return <div style={{ color: "var(--mut2)", display: "flex", gap: 10, alignItems: "center", paddingTop: 8 }}><span className="spin" /> Reading your documents…</div>;
      if (!liveAnswer) return <div style={{ color: "var(--mut2)", fontSize: 13, lineHeight: 1.6, paddingTop: 8 }}>Ask a question below and the grounded answer, with citations to your real documents, appears here.</div>;
      return (
        <div>
          <div style={{ fontSize: 13, color: "var(--mut2)", marginBottom: 8 }}>{lastQuestion}</div>
          {liveAnswer.answerable ? (
            <>
              <div style={{ fontSize: 18, lineHeight: 1.5, letterSpacing: "-0.012em", marginBottom: 14 }}>{liveAnswer.answer.replace(/\[\d+\]/g, "")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {liveAnswer.citations.slice(0, 3).map((c) => (
                  <span key={c.n} className="cite"><span className="tag">SRC</span><span className="ref">{c.document.replace(/^uploads\//, "")}</span></span>
                ))}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginTop: 14 }}>SOURCED · {liveAnswer.citations.length} CITATION{liveAnswer.citations.length === 1 ? "" : "S"}</div>
            </>
          ) : (
            <div style={{ borderLeft: "3px solid var(--warn)", paddingLeft: 12, color: "var(--mut)", fontSize: 14 }}>I can't find this in your documents.</div>
          )}
        </div>
      );
    }
    if (id === "inbox") {
      if (queue.length === 0) return <div style={{ color: "var(--mut2)", fontSize: 13, paddingTop: 8 }}>Inbox clear — Levi will draft replies as mail arrives.</div>;
      const d = queue[0];
      return (
        <div>
          <div style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(var(--s5),0.5)", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>{d.subject}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginBottom: 8 }}>to {d.from} · {d.category}{d.confident ? "" : " · low confidence"}</div>
            <div style={{ fontSize: 12.5, color: "var(--mut)", lineHeight: 1.5, maxHeight: 96, overflow: "hidden" }}>{d.draft}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div onClick={() => verdict(d.id, "approved")} style={{ flex: 1, textAlign: "center", padding: 10, borderRadius: 11, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, background: "rgba(48,209,88,0.16)", border: "1px solid rgba(48,209,88,0.34)", color: "var(--ok)" }}>APPROVE</div>
            <div onClick={() => verdict(d.id, "rejected")} style={{ flex: 1, textAlign: "center", padding: 10, borderRadius: 11, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, border: "1px solid rgba(var(--lineRGB),0.16)", color: "var(--mut)" }}>REJECT</div>
          </div>
          {queue.length > 1 && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--warn)", marginTop: 10 }}>{queue.length} AWAITING</div>}
        </div>
      );
    }
    return windowContent(id);
  }

  const inboxCount = queue.length;

  if (authed === false) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg,#1d1813,#0e0c0a)" }}>
        <div style={{ width: 420, padding: 30, borderRadius: 16, background: "rgba(44,38,32,0.9)", border: "1px solid rgba(255,235,215,0.1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 8 }}>
            <svg viewBox="113 221 131 157" style={{ width: 26, height: 31 }}><path d={FLAME} fill="#ff9f0a" /></svg>
            <span style={{ fontWeight: 700, fontSize: 20 }}>FireLever <span style={{ fontWeight: 400, fontStyle: "italic", color: "#b5a99c" }}>Levi</span></span>
          </div>
          <div style={{ color: "#93887c", fontSize: 13.5, marginBottom: 16 }}>Paste your workspace API key (starts with flv_).</div>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} placeholder="flv_…" type="password" style={{ flex: 1, padding: "11px 13px", borderRadius: 8, background: "#1e1a16", border: "1px solid rgba(255,235,215,0.14)", color: "#f8f4ef", outline: "none" }} />
            <button onClick={connect} style={{ padding: "11px 20px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, background: "linear-gradient(135deg,#ff9f0a,#ff7a45)", color: "#0e0c0a" }}>Connect</button>
          </div>
        </div>
      </div>
    );
  }
  if (authed === null) return <div style={{ height: "100vh", background: "#0e0c0a" }} />;

  return (
    <div className="shell">
      <div className="rail">
        <svg viewBox="113 221 131 157" style={{ width: 34, height: 41, marginBottom: 18 }}><path d={FLAME} fill="var(--acc)" /></svg>
        {[["chat", "chat"], ["schedule", "calendar"], ["docs", "file"], ["tasks", "check"]].map(([id, ic]) => {
          const I = Icon[ic as keyof typeof Icon];
          return <div key={id} className={"rail-nav" + (nav === id ? " active" : "")} onClick={() => setNav(id)}><I /></div>;
        })}
        <div className="rail-avatar">{(tenant[0] ?? "A").toUpperCase()}</div>
      </div>

      <div className="center">
        <div className="topbar">
          <div className="brand">
            <svg viewBox="113 221 131 157" style={{ width: 22, height: 26 }}><path d={FLAME} fill="var(--acc)" /></svg>
            <span className="wordmark">FireLever</span>
            <span className="badge">COPILOT</span>
            <div className="themedots" style={{ marginLeft: 14 }}>
              <span className="lab">THEME</span>
              {THEME_ORDER.map((t) => (
                <span key={t} className={"themedot" + (theme === t ? " on" : "")} style={{ background: THEMES[t]["--acc"] }} onClick={() => setTheme(t)} title={t} />
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span className="clock">{now}</span>
            <span className={"pill" + (auto ? " on" : "")} onClick={() => setAuto((a) => !a)}><span className="dot" /> {auto ? "AUTO" : "MANUAL"}</span>
          </div>
        </div>

        <div className="stage">
          <Orb theme={theme} mode={mode} level={level} />
          <div className="window-stack" style={{ transformStyle: "preserve-3d" }}>
            {WINDOWS.map((w) => (
              <div key={w.id} className={"card" + (order[0] === w.id ? " focused" : "")} style={rankStyle(w.id)} onClick={() => promote(w.id)}>
                <div className="card-head">
                  <span className="card-chip">{(() => { const I = Icon[w.icon]; return <I size={15} />; })()}</span>
                  <span className="card-label">{w.label}</span>
                  <span className="card-meta">{w.tier === "preview" ? "PREVIEW" : w.id === "inbox" && inboxCount ? `${inboxCount} AWAITING` : w.meta ?? ""}</span>
                </div>
                {renderWindow(w.id)}
              </div>
            ))}
          </div>
        </div>

        <div className="promptbar">
          <div className="chips">
            {suggestions.map((s) => <span key={s} className="chip" onClick={() => submitAsk(s)}>{s}</span>)}
          </div>
          <div className="inputrow">
            <span style={{ color: "var(--acc)" }}><Icon.sparkle size={18} /></span>
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAsk(input)} placeholder='Ask Levi anything — or say "Hey Levi"…' />
            <span className="kbd">⌘K</span>
            <span className={"mic" + (mic ? " on" : "")} onClick={() => setMic((m) => !m)}><Icon.mic size={18} /></span>
            <span className="send" onClick={() => submitAsk(input)}>{busy ? <span className="spin" style={{ borderColor: "rgba(0,0,0,0.25)", borderTopColor: "var(--onAcc)" }} /> : <Icon.send size={18} />}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">CONVERSATION</span>
          <span className="live">LIVE</span>
        </div>
        <div className="messages">
          {messages.length === 0 && <div style={{ color: "var(--mut2)", fontSize: 13, padding: "20px 4px", lineHeight: 1.6 }}>Connected to <b style={{ color: "var(--tx2)" }}>{tenant}</b>. Ask about your documents or inbox — answers are grounded in your real data, with citations.</div>}
          {messages.map((m, i) => (
            <div key={i} className={"msg " + (m.role === "user" ? "user" : "bot")}>
              {m.text}
              {m.cite && <div className="cite"><span className="tag">SRC</span><span className="ref">{m.cite}</span></div>}
            </div>
          ))}
          <div ref={msgEndRef} />
        </div>
        <div className="dock">
          <div className="dock-head"><span className="panel-title">WINDOWS</span><span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)" }}>TAP TO SURFACE</span></div>
          <div className="dock-grid">
            {WINDOWS.map((w) => {
              const I = Icon[w.icon];
              return (
                <div key={w.id} className={"dock-item" + (active === w.id ? " active" : "")} onClick={() => promote(w.id)}>
                  <I size={15} /> {w.dockLabel}
                  {w.id === "inbox" && inboxCount > 0 && <span className="badge-n">{inboxCount}</span>}
                  {w.tier === "preview" && <span className="preview-tag">PREVIEW</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
