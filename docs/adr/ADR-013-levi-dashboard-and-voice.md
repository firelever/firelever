# ADR-013: Levi — voice-first dashboard, React frontend, voice pipeline

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

A high-fidelity design prototype ("Levi") reframes the copilot as a voice-first
desktop dashboard: a WebGL orb, a 3D-stacked window stage, a live conversation panel,
five themes, and an approve/undo contract on every action. It bundles 12 "windows"
spanning capabilities we already have (Answer, Inbox) and integrations we don't
(flight, lunch, code PR, Slack, market data). This ADR sets scope and the two
architectural changes it forces.

## Decisions

1. **Tiered scope — build what's real, stub the rest.** (Peter's call: shell + real
   windows + voice.)
   - **Real, wired to existing backends:** Answer (RAG Q&A + citations),
     Inbox (triage, drafted replies, approve/undo), plus Contract redlines and Sheet
     analysis (extensions of the OCR/docs stack). Tasks/Schedule/Notes as simple
     stored state.
   - **Preview stubs, clearly labeled:** Flight, Lunch, Code PR, Slack, Weather/Stocks.
     Each is a real integration (Amadeus, DoorDash, GitHub, Slack, market data) and
     two spend the user's money autonomously — off-strategy for an SMB ops copilot and
     the job hunt. Shipped as convincing non-functional previews so the demo reads
     complete without five integrations. Promoting a stub to real is a later, isolated
     decision per window.
2. **New React frontend (Vite + React + WebGL canvas).** The current single vanilla
   HTML file can't carry a WebGL orb, a 3D stage, themed component system, and voice
   state. This is the moment ADR-005's "add a framework when it earns it" triggers.
   The new app lives in `web/` as a Vite build; the Hono server serves the built
   assets. The old single-file UI is retained until parity is reached.
3. **Voice = Deepgram (STT) + Claude (brain) + ElevenLabs (TTS).** (Peter's call.)
   Anthropic has no speech API, so a voice vendor is required regardless. Keeping the
   brain on Claude preserves grounding, citations, and refusals — the whole reason the
   product is trustworthy. Deepgram streams speech to text; the existing `answer()`
   path reasons; ElevenLabs speaks. Rejected: OpenAI Realtime (moves reasoning off
   Claude), ElevenLabs Conversational AI end-to-end (less pipeline control — revisit
   if assembling the loop proves slow). Voice keys are server-side secrets; the
   browser gets short-lived tokens, never the raw keys.
4. **The approve/undo contract is load-bearing, not decoration.** Every consequential
   action defers its side effect until the undo window expires — the same
   human-in-the-loop principle already in the product, now a first-class UI pattern.

## Consequences

- A build step and a real frontend codebase — the biggest structural change since the
  project began. Slower to iterate than the single HTML file; worth it for this design.
- Voice adds two vendors and cost per minute; scoped to the copilot surface, keys
  server-side. Latency budget: aim < 2s from end-of-speech to first audio.
- Stubs must be visibly labeled "preview" in the UI so a demo never implies a
  capability that isn't wired — same honesty rule as the OCR legibility flags.
- Delivered in vertical slices (shell → orb → voice → per-window wiring), each
  demoable, so the north-star design lands incrementally rather than in one big bang.
