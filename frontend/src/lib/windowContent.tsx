import { ReactNode } from "react";

// Representative content per window (L1: static/sample; L4-L5 wire real data).
const mono = (s: ReactNode) => <span style={{ fontFamily: "var(--mono)" }}>{s}</span>;

const greenBtn = {
  flex: 1, textAlign: "center" as const, padding: "10px", borderRadius: 11,
  fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.04em", cursor: "pointer",
  background: "rgba(48,209,88,0.16)", border: "1px solid rgba(48,209,88,0.34)", color: "var(--ok)",
};
const neutralBtn = { ...greenBtn, background: "transparent", border: "1px solid rgba(var(--lineRGB),0.16)", color: "var(--mut)" };
const row = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderRadius: 10, background: "rgba(var(--s5),0.5)", marginBottom: 8 };

export const CONTENT: Record<string, ReactNode> = {
  answer: (
    <div>
      <div style={{ fontSize: 13, color: "var(--mut2)", marginBottom: 8 }}>What are Northwind's retention terms?</div>
      <div style={{ fontSize: 19, lineHeight: 1.5, letterSpacing: "-0.012em", marginBottom: 14 }}>
        The master agreement sets a <span style={{ color: "var(--accM)" }}>36-month</span> retention term with a 90-day
        cure period on breach.
      </div>
      <div className="cite"><span className="tag">PDF</span><span className="ref">Northwind_MSA_v4 · p.12</span></div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginTop: 14 }}>SOURCED FROM 2 OF 248 DOCS</div>
    </div>
  ),
  inbox: (
    <div>
      <div style={{ ...row, flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>Re: pricing deck</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginBottom: 6 }}>to j.okafor@northwind.com</div>
        <div style={{ fontSize: 12.5, color: "var(--mut)" }}>Grounded reply drafted from the signed MSA and current pricing.</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={greenBtn}>APPROVE & SEND</div>
        <div style={neutralBtn}>EDIT</div>
      </div>
    </div>
  ),
  lunch: (
    <div>
      <div style={row}><span style={{ fontSize: 14 }}>Chicken pesto bowl</span>{mono("$12.90")}</div>
      <div style={row}><span style={{ fontSize: 14 }}>Iced green tea</span>{mono("$3.50")}</div>
      <div style={{ fontSize: 12.5, color: "var(--mut)", margin: "6px 0 12px" }}>Sweetgreen · nothing is ordered until you approve.</div>
      <div style={{ display: "flex", gap: 8 }}><div style={greenBtn}>APPROVE · $16.40</div><div style={neutralBtn}>SWAP</div></div>
    </div>
  ),
  flight: (
    <div>
      <div style={{ ...row, border: "1px solid rgba(var(--accRGB),0.28)", background: "rgba(var(--accRGB),0.08)" }}>
        <div><div style={{ fontSize: 15, fontWeight: 600 }}>8:05a → 4:32p</div><div style={{ fontSize: 12, color: "var(--mut2)" }}>United · nonstop · 5h 27m</div></div>
        <div style={{ textAlign: "right" }}>{mono(<span style={{ color: "var(--accM)" }}>$348</span>)}<div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)" }}>SEAT 14C HELD</div></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}><div style={greenBtn}>CONFIRM · TICKET 14C</div><div style={neutralBtn}>CHANGE</div></div>
    </div>
  ),
};

export function windowContent(id: string): ReactNode {
  return (
    CONTENT[id] ?? (
      <div style={{ color: "var(--mut2)", fontSize: 13, lineHeight: 1.6, paddingTop: 8 }}>
        This window is a labeled preview. Its backend integration is scoped for a later slice
        (see ADR-013). The design and interaction are final; the data is not yet wired.
      </div>
    )
  );
}
