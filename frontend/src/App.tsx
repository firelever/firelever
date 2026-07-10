import { useEffect, useMemo, useRef, useState } from "react";
import { applyTheme, THEME_ORDER, THEMES, ThemeName } from "./theme";
import { Icon } from "./lib/icons";
import { WINDOWS } from "./lib/windows";
import { windowContent } from "./lib/windowContent";
import { Orb, OrbMode } from "./components/Orb";

interface Msg { role: "user" | "bot"; text: string; cite?: string }

const FLAME = "M153.16 245.75C140.05 258.89 128.61 270.53 127.74 271.64C124.49 275.75 121.05 281.38 119.09 285.79C112.95 299.64 111.66 315.12 115.45 329.59C119.42 344.75 129.08 358.26 142.21 367.03C150.86 372.81 159.60 376.14 170.16 377.68C174.54 378.32 183.90 378.26 188.40 377.56C209.35 374.31 227.52 361.22 237.05 342.50C246.73 323.53 246.54 301.11 236.56 282.10C232.61 274.57 230.40 271.83 219.47 260.85C211.47 252.81 210.16 251.59 209.54 251.58C208.92 251.57 207.22 253.21 194.80 265.73C184.53 276.10 180.63 279.89 180.24 279.89C179.95 279.89 179.50 279.68 179.24 279.42C178.77 278.95 178.77 278.63 178.77 250.78L178.77 222.61L178.24 222.24C177.96 222.04 177.56 221.88 177.36 221.88C177.16 221.88 166.27 232.62 153.16 245.75Z";

export function App() {
  const [theme, setTheme] = useState<ThemeName>("ember");
  const [order, setOrder] = useState<string[]>(WINDOWS.map((w) => w.id));
  const active = order[0];
  const [nav, setNav] = useState("chat");
  const [auto, setAuto] = useState(true);
  const [mic, setMic] = useState(true);
  const [now, setNow] = useState("");
  const [input, setInput] = useState("");
  const [messages] = useState<Msg[]>([
    { role: "user", text: "Catch me up on Slack." },
    { role: "bot", text: "Three unread in #northwind-deal — retention terms and the pricing deck. A sourced reply is drafted; send when ready." },
    { role: "user", text: "What are the retention terms?" },
    { role: "bot", text: "36-month term with a 90-day cure period on breach.", cite: "Northwind_MSA_v4 · p.12" },
    { role: "user", text: "Order my usual lunch." },
    { role: "bot", text: "Sweetgreen chicken pesto bowl and iced tea, $16.40 — lands 12:15. Approve to place it." },
  ]);
  const mode: OrbMode = mic ? "hearing" : "muted";
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); inputRef.current?.focus(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const promote = (id: string) => setOrder((o) => [id, ...o.filter((x) => x !== id)]);

  const rankStyle = useMemo(() => (id: string) => {
    const rank = order.indexOf(id);
    if (rank === 0) return { transform: "translateZ(0)", opacity: 1, filter: "none", zIndex: 20 };
    if (rank <= 2) return { transform: `translate(0, ${rank * 60}px) translateZ(-${rank * 40}px)`, opacity: 0.6 - rank * 0.12, filter: `blur(${0.4 + rank}px)`, zIndex: 20 - rank };
    if (rank <= 4) return { transform: `translate(0, ${120 + rank * 12}px) translateZ(-${140 * rank}px)`, opacity: 0.16, filter: `blur(${0.4 + rank}px)`, zIndex: 20 - rank };
    return { opacity: 0, pointerEvents: "none" as const };
  }, [order]);

  const suggestions = ["What's on today?", "Any replies to approve?", "Northwind retention terms?", "What should I focus on?", "Prep my 2:30 sync", "Order my usual", "Market check"];

  return (
    <div className="shell">
      {/* icon rail */}
      <div className="rail">
        <svg viewBox="113 221 131 157" style={{ width: 34, height: 41, marginBottom: 18 }}><path d={FLAME} fill="var(--acc)" /></svg>
        {[["chat", "chat"], ["schedule", "calendar"], ["docs", "file"], ["tasks", "check"]].map(([id, ic]) => {
          const I = Icon[ic as keyof typeof Icon];
          return <div key={id} className={"rail-nav" + (nav === id ? " active" : "")} onClick={() => setNav(id)}><I /></div>;
        })}
        <div className="rail-avatar">A</div>
      </div>

      {/* center */}
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
            <span className={"pill" + (auto ? " on" : "")} onClick={() => setAuto((a) => !a)}>
              <span className="dot" /> {auto ? "AUTO" : "MANUAL"}
            </span>
          </div>
        </div>

        <div className="stage">
          <Orb theme={theme} mode={mode} />
          <div className="window-stack" style={{ transformStyle: "preserve-3d" }}>
            {WINDOWS.map((w) => {
              const win = WINDOWS.find((x) => x.id === w.id)!;
              return (
                <div key={w.id} className={"card" + (order[0] === w.id ? " focused" : "")} style={rankStyle(w.id)} onClick={() => promote(w.id)}>
                  <div className="card-head">
                    <span className="card-chip">{(() => { const I = Icon[win.icon]; return <I size={15} />; })()}</span>
                    <span className="card-label">{win.label}</span>
                    <span className="card-meta">{win.tier === "preview" ? "PREVIEW" : win.meta ?? ""}</span>
                  </div>
                  {windowContent(w.id)}
                </div>
              );
            })}
          </div>
        </div>

        <div className="promptbar">
          <div className="chips">
            {suggestions.map((s) => <span key={s} className="chip" onClick={() => setInput(s)}>{s}</span>)}
          </div>
          <div className="inputrow">
            <span style={{ color: "var(--acc)" }}><Icon.sparkle size={18} /></span>
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder='Ask Levi anything — or say "Hey Levi"…' />
            <span className="kbd">⌘K</span>
            <span className={"mic" + (mic ? " on" : "")} onClick={() => setMic((m) => !m)}><Icon.mic size={18} /></span>
            <span className="send"><Icon.send size={18} /></span>
          </div>
        </div>
      </div>

      {/* right panel */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">CONVERSATION</span>
          <span className="live">LIVE</span>
        </div>
        <div className="messages">
          {messages.map((m, i) => (
            <div key={i} className={"msg " + (m.role === "user" ? "user" : "bot")}>
              {m.text}
              {m.cite && <div className="cite"><span className="tag">PDF</span><span className="ref">{m.cite}</span></div>}
            </div>
          ))}
        </div>
        <div className="dock">
          <div className="dock-head"><span className="panel-title">WINDOWS</span><span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)" }}>TAP TO SURFACE</span></div>
          <div className="dock-grid">
            {WINDOWS.map((w) => {
              const I = Icon[w.icon];
              return (
                <div key={w.id} className={"dock-item" + (active === w.id ? " active" : "")} onClick={() => promote(w.id)}>
                  <I size={15} /> {w.dockLabel}
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
