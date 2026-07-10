import { ORB_COLORS, ThemeName } from "../theme";

export type OrbMode = "listening" | "hearing" | "thinking" | "responding" | "muted";

const LABEL: Record<OrbMode, string> = {
  listening: "LISTENING",
  hearing: "HEARING YOU",
  thinking: "THINKING",
  responding: "RESPONDING",
  muted: "MUTED",
};
const DOT: Record<OrbMode, string> = {
  listening: "var(--acc)",
  hearing: "var(--okD)",
  thinking: "var(--warn)",
  responding: "var(--acc2)",
  muted: "var(--mut2)",
};

// L1 placeholder: a CSS "liquid glass" sphere. Replaced by the WebGL shader in L2.
export function Orb({ theme, mode, name = "LEVI" }: { theme: ThemeName; mode: OrbMode; name?: string }) {
  const [base, hi, sec] = ORB_COLORS[theme];
  const speed = mode === "thinking" ? "2.4s" : mode === "responding" ? "3s" : "6s";
  return (
    <div className="orb-assembly">
      <div
        style={{
          width: 146, height: 146, borderRadius: "50%",
          background: `radial-gradient(circle at 38% 32%, ${hi}, ${base} 45%, ${sec} 78%, ${base})`,
          boxShadow: `0 0 42px -6px ${base}, inset 0 0 30px -8px ${hi}, var(--orbShadow)`,
          filter: "saturate(1.1)",
          animation: `orbspin ${speed} ease-in-out infinite`,
        }}
      />
      <div className="orb-status">
        <span className="dot" style={{ background: DOT[mode], animation: "blink 1.6s infinite" }} />
        {name} · {LABEL[mode]}
      </div>
      <style>{`@keyframes orbspin{0%,100%{transform:rotate(0) scale(1)}50%{transform:rotate(8deg) scale(1.03)}}@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </div>
  );
}
