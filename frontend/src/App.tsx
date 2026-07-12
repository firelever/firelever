import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { applyTheme, THEME_ORDER, THEMES, ThemeName } from "./theme";
import { Icon } from "./lib/icons";
import { WINDOWS } from "./lib/windows";
import { windowContent } from "./lib/windowContent";
import { Orb, OrbMode } from "./components/Orb";
import { api, AskResult, getKey, setKey, WsItem, RedlineResult, UiEmail, UiEvent } from "./lib/api";
import { playAudio } from "./lib/voice";
import { startLive, LiveConvo } from "./lib/live";

interface Msg { role: "user" | "bot"; text: string; cite?: string }
interface Draft { id: number; from: string; subject: string; category: string; urgency: string; draft: string; confident: boolean; grounded_in: string[]; attachments: string[] }

// FireLever brand mark — flame with the eyes/mouth cut out via fill-rule evenodd.
const FLAME = "M153.15921545124678,245.75429637825115C140.04694207912632,258.88732298880234 128.60624772969635,270.53460639351965 127.73531921237188,271.6371221851503C124.49003155277207,275.7453200654082 121.04829562484534,281.38029596385144 119.09324623177199,285.7870574788054C112.9455710111886,299.6426741183526 111.66004938976003,315.1170433554939 115.4534112097341,329.5938421544325C119.42459054989841,344.74842285393714 129.0845155426219,358.26161105937786 142.21424050160454,367.03009012860105C150.86386011436105,372.80632954772597 159.60262431946757,376.1367526513426 170.16036270657347,377.68051059188036C174.54094684123422,378.32103099617314 183.90372319279095,378.25995044215557 188.40340261617325,377.5616511354137C209.34860850235145,374.31070350169637 227.5150029291106,361.220598361536 237.0548893040929,342.5047147808732C246.72778507083558,323.5282365585523 246.54430757652784,301.1081357502655 236.56034906557966,282.0995843412789C232.607800473552,274.5744129198582 230.40347638705543,271.8335704534772 219.46699139858936,260.8463815302089C211.4677971448312,252.80992578017742 210.15845646565833,251.5873713708056 209.54434927391367,251.58123973217835C208.9186863016792,251.5748722612962 207.21503409232315,253.21060478124275 194.8048333430229,265.7328258516178C184.5256128489471,276.1049642541219 180.6308431593685,279.89172277095895 180.24219160330279,279.891486938704C179.95046710399856,279.89125110644915 179.49932000038586,279.6790020770443 179.2399045200022,279.4195865966606C178.7734283198214,278.9531103964798 178.76824001021367,278.6335576910981 178.76824001021367,250.7794100655379L178.76824001021367,222.61066221194878L178.24398490758375,222.24370722333333C177.95579789210296,222.04183481314385 177.5579488780964,221.87628057020808 177.35961395173035,221.87628057020808C177.16151485761912,221.87604473795318 166.27125299111236,232.62103393544513 153.15921545124678,245.75429637825115M213.1825334701673,297.2213843573533C217.16338193278227,298.0585888622279 220.54285814541691,299.82874576746417 223.51764620865305,302.63444210394107C227.6307965662637,306.51388269695155 229.76649346658604,310.76381576240084 230.41762632234907,316.3657751451589C231.4913705788826,325.6004945823081 225.87101628024277,334.9491209985712 217.0942830820983,338.52740380208166C213.2245116115385,340.1051215873242 215.18569264323912,340.02847610448356 178.6651813148249,340.02847610448356L145.57626512737698,340.02847610448356L143.29317306774573,339.4492720864633C137.20209758833698,337.90409915239616 132.06449191546568,333.7631205887079 129.23568401800912,328.1189472323238C127.49217615757591,324.6401856403787 127.05093400866875,322.72428440161775 127.03560491210062,318.5677409091066C127.02169080906187,314.7715491020738 127.31294364385627,313.1702480913418 128.5628545947958,310.16763182202817C131.30652704823552,303.5770636267534 137.2792147356874,298.67835602809 144.33673079565278,297.2301101507844C146.74740810518185,296.73533408001623 210.83364421142056,296.7273157833498 213.1825334701673,297.2213843573533M146.8709842067464,310.0836755392858C144.26362279663556,310.74023253691144 142.12438841248982,312.51675691302984 140.95701875076327,314.99464641520376C140.31414002392154,316.3587001775121 140.2198071219638,316.80890395210525 140.23254206372812,318.44982478165946C140.26013443755073,321.9840069535047 142.06943949709944,324.8330964248822 145.21685677091816,326.2980863922853C146.38894307774257,326.84380223011055 146.88702080007926,326.93176766118614 148.8175436386436,326.93554097726445C150.75443394809008,326.93931429334276 151.23364509003522,326.85582967511016 152.3550274620574,326.32072628875517C154.16338919258652,325.4573444035873 155.44560916244657,324.264740690587 156.31134937016338,322.64032811887546C159.2962782203599,317.0400195619016 155.68332807537996,310.4124257026084 149.40712427587923,309.97566436654427C148.49917009453634,309.9124613222326 147.35797781310305,309.96104276674083 146.8709842067464,310.0836755392858M206.91599879311724,310.0728272555607C202.48871987198743,311.0137979525888 199.45544540953756,315.4637167701884 200.2471342892175,319.8560925175939C200.77115355959256,322.7622533946558 202.45428836277284,324.96327582958384 205.17437759072317,326.29926555355974C206.31533403990153,326.85960299118847 206.75893451135767,326.93978595785256 208.7189363817838,326.93978595785256C210.65794918152432,326.93978595785256 211.14140530405757,326.8544146815808 212.3120766173526,326.3058688566968C216.87543074955641,324.16710613706084 218.61327863587218,318.7788107772369 216.20260132634309,314.24399234787535C214.5567280194361,311.1477506733687 210.47777333878508,309.3155698850952 206.91599879311724,310.0728272555607";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [tenant, setTenant] = useState("");
  const [theme, setTheme] = useState<ThemeName>("ember");
  const [order, setOrder] = useState<string[]>(WINDOWS.map((w) => w.id));
  const active = order[0];
  const [nav, setNav] = useState("chat");
  const [auto, setAuto] = useState(false);
  const [now, setNow] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [liveAnswer, setLiveAnswer] = useState<AskResult | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [queue, setQueue] = useState<Draft[]>([]);
  const [tasks, setTasks] = useState<WsItem[]>([]);
  const [events, setEvents] = useState<WsItem[]>([]);
  const [notes, setNotes] = useState<WsItem[]>([]);
  const [redlines, setRedlines] = useState<RedlineResult | null>(null);
  const [redlinesBusy, setRedlinesBusy] = useState(false);
  const [focusEmail, setFocusEmail] = useState<UiEmail | null>(null);
  // Live activity: the brain's real steps this conversation (routing decisions,
  // searches, executing actions with truthful results) plus spoken captions.
  const [activity, setActivity] = useState<UiEvent[]>([]);
  const lastEvIdRef = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const uiSeqRef = useRef(0);
  const [mode, setMode] = useState<OrbMode>("muted");
  const [level, setLevel] = useState(0);
  const [voiceReady, setVoiceReady] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [liveReady, setLiveReady] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const convoRef = useRef<LiveConvo | null>(null);
  const liveRaf = useRef(0);
  const lastRoleRef = useRef<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.voiceStatus().then((s) => setVoiceReady(s.configured)).catch(() => {});
    api.convaiStatus().then((s) => setLiveReady(s.configured)).catch(() => {});
  }, []);

  // Tap the mic for a live, interruptible conversation with Levi. ElevenLabs
  // owns the voice loop (streaming STT, echo cancellation, turn-taking,
  // barge-in, TTS); our server is the agent's Custom LLM, so every reply is
  // grounded in your documents.
  // A deliberate mic-off ends the session; an UNEXPECTED drop (the single-
  // machine server restarts on every deploy) flips into a reconnect loop that
  // polls health and reopens the session, so Levi comes back on his own.
  const endingRef = useRef(false);
  const reconnectSeq = useRef(0);
  const [reconnecting, setReconnecting] = useState(false);

  const liveHandlers = () => ({
    onStatus: (s: string) => {
      if (s === "connected") {
        setMode("hearing");
        setReconnecting(false);
      }
      if (s === "disconnected") {
        cancelAnimationFrame(liveRaf.current);
        convoRef.current = null;
        setLevel(0);
        if (endingRef.current) {
          setLiveOn(false);
          setMode("muted");
          return;
        }
        beginReconnect();
      }
    },
    onMode: (m: string) => setMode(m === "speaking" ? "responding" : "hearing"),
    onMessage: (role: string, text: string) => {
      const t = text.trim();
      if (!t) return;
      const r = role === "user" ? "user" : "bot";
      const prevRole = lastRoleRef.current;
      lastRoleRef.current = r;
      // The SDK can report a message twice; skip an immediate duplicate.
      setMessages((m) => (m.length && m[m.length - 1].role === r && m[m.length - 1].text === t ? m : [...m, { role: r, text: t }]));
      // Window surfacing is driven by the server's ui-context (the brain's
      // actual intent), never by keyword-scanning transcript prose — Levi
      // saying "worth a note" must not yank the Notes window forward.
      if (r === "user") setLastQuestion(t);
      else {
        // Only surface a real answer (an agent reply to a question) in the
        // card, not the opening greeting or a reconnect greeting.
        if (prevRole === "user") setLiveAnswer({ answerable: true, answer: t, citations: [] });
        // Levi may have executed an action (sent a reply, added a task) —
        // refresh the windows so they show the new state.
        loadTriage();
        loadWorkspace();
      }
    },
    onError: (msg: string) => setMessages((m) => [...m, { role: "bot", text: "Voice: " + msg }]),
  });

  async function openSession(firstMessage?: string) {
    const convo = await startLive(liveHandlers(), firstMessage);
    convoRef.current = convo;
    // Drive the orb from live mic / agent volume.
    const tick = () => {
      const c = convoRef.current;
      if (!c) return;
      setLevel(Math.min(1, Math.max(c.getInputVolume(), c.getOutputVolume()) * 1.7));
      liveRaf.current = requestAnimationFrame(tick);
    };
    liveRaf.current = requestAnimationFrame(tick);
  }

  function beginReconnect() {
    const token = ++reconnectSeq.current;
    setReconnecting(true);
    setMode("thinking");
    void (async () => {
      // ~2 minutes of patience: deploys take 30-90s. Poll health first so we
      // only attempt a session once the brain is actually back.
      for (let i = 0; i < 15 && reconnectSeq.current === token; i++) {
        await new Promise((r) => setTimeout(r, Math.min(2500 + i * 1500, 10_000)));
        if (reconnectSeq.current !== token) return;
        try {
          const ok = await fetch("/api/health").then((r) => r.ok).catch(() => false);
          if (!ok) continue;
          const line = ["Sorry, I dropped for a second there. Where were we?", "Back. I lost the line for a moment. What were we doing?", "I'm back. Sorry about the hiccup."];
          await openSession(line[Math.floor(Math.random() * line.length)]);
          return; // onConnect clears the reconnecting state
        } catch {
          /* server up but session failed — try again */
        }
      }
      if (reconnectSeq.current !== token) return;
      setReconnecting(false);
      setLiveOn(false);
      setMode("muted");
      setMessages((m) => [...m, { role: "bot", text: "I couldn't reconnect to Levi. Tap the mic to start again." }]);
    })();
  }

  async function toggleLive() {
    if (liveOn) {
      endingRef.current = true;
      reconnectSeq.current++; // cancels any reconnect loop in flight
      setReconnecting(false);
      const hadSession = Boolean(convoRef.current);
      await convoRef.current?.endSession().catch(() => {});
      // Mid-reconnect there is no session to end; settle the state directly.
      if (!hadSession) {
        setLiveOn(false);
        setMode("muted");
      }
      return;
    }
    endingRef.current = false;
    setLiveOn(true);
    lastRoleRef.current = "";
    setMode("thinking");
    // Conversation boundary: reset the context bus and local state so the
    // windows can only ever reflect THIS conversation.
    setFocusEmail(null);
    setActivity([]);
    promote("answer");
    api.uiSessionStart().catch(() => {});
    try {
      await openSession();
    } catch (e) {
      setLiveOn(false);
      setMode("muted");
      setMessages((m) => [...m, { role: "bot", text: "Couldn't start voice: " + (e instanceof Error ? e.message : e) }]);
    }
  }

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date().toTimeString().slice(0, 8));
      setNowMs(Date.now()); // ages the activity feed + expires the caption
    }, 1000);
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
  const loadWorkspace = () => {
    api.workspace("task").then((r) => setTasks(r.items)).catch(() => {});
    api.workspace("event").then((r) => setEvents(r.items)).catch(() => {});
    api.workspace("note").then((r) => setNotes(r.items)).catch(() => {});
  };
  useEffect(() => { if (authed) loadWorkspace(); }, [authed]);

  // Follow the voice conversation in real time: the brain publishes which
  // window (and which email) it's discussing; surface it as it speaks.
  // The first poll only PRIMES the sequence number — leftover context from an
  // earlier session must never be applied to a fresh page.
  const uiPrimedRef = useRef(false);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => {
      api
        .uiContext()
        .then((ctx) => {
          if (!uiPrimedRef.current) {
            uiPrimedRef.current = true;
            uiSeqRef.current = ctx.seq ?? 0;
            // Prime past the events too — history from before this page load
            // must not replay as if it were happening now.
            lastEvIdRef.current = Math.max(0, ...(ctx.events ?? []).map((e) => e.id));
            return;
          }
          if (!ctx.seq || ctx.seq === uiSeqRef.current) return;
          uiSeqRef.current = ctx.seq;
          const fresh = (ctx.events ?? []).filter((e) => e.id > lastEvIdRef.current);
          if (fresh.length) {
            lastEvIdRef.current = fresh[fresh.length - 1].id;
            setActivity((a) => [...a, ...fresh].slice(-24));
          }
          if (ctx.email !== undefined) setFocusEmail(ctx.email ?? null);
          if (ctx.theme && (THEME_ORDER as readonly string[]).includes(ctx.theme)) setTheme(ctx.theme as ThemeName);
          if (ctx.window) {
            promote(ctx.window);
            if (ctx.window === "inbox") loadTriage();
            else if (ctx.window === "tasks" || ctx.window === "schedule" || ctx.window === "notes") loadWorkspace();
          }
        })
        .catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [authed]);

  const toggleTask = async (t: WsItem) => { await api.setItem(t.id, { done: t.done ? 0 : 1 }).catch(() => {}); loadWorkspace(); };
  const addItem = async (kind: "task" | "event" | "note", title: string, at?: string) => {
    if (!title.trim()) return;
    await api.addItem(kind, title.trim(), undefined, at).catch(() => {});
    loadWorkspace();
  };
  const runRedlines = async () => {
    setRedlinesBusy(true);
    try { setRedlines(await api.redlines()); }
    catch (e) { setRedlines({ document: "", redlines: [], ...(e instanceof Error ? { error: e.message } : {}) } as RedlineResult); }
    finally { setRedlinesBusy(false); }
  };

  const promote = (id: string) => setOrder((o) => [id, ...o.filter((x) => x !== id)]);

  // Contextual window surfacing: bring forward the window that matches what
  // the conversation is about right now (same domains the voice brain routes).
  const windowFor = (text: string): string | null => {
    const s = text.toLowerCase();
    if (/\b(inbox|e-?mails?|reply|replies|senders?|unread|mailbox|newsletters?|spam|messages?|inquir(y|ies))\b/.test(s)) return "inbox";
    if (/\b(schedules?|calendars?|appointments?|meetings?|events?)\b/.test(s)) return "schedule";
    if (/\b(tasks?|to-?dos?|reminders?|check(ed)? (that |it |this )?off)\b/.test(s)) return "tasks";
    if (/\bnotes?\b/.test(s)) return "notes";
    if (/\b(documents?|contracts?|clauses?|agreements?|sellers?|buyers?|closing|deposit|price|propert(y|ies)|warranty)\b/.test(s)) return "answer";
    return null;
  };

  async function submitAsk(q: string) {
    if (!q.trim() || busy) return;
    setInput("");
    setBusy(true);
    setMode("thinking");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLastQuestion(q);
    promote(windowFor(q) ?? "answer");
    try {
      const r = await api.ask(q, speakReplies && voiceReady);
      setLiveAnswer(r);
      const cite = r.citations[0];
      setMode("responding");
      setMessages((m) => [
        ...m,
        { role: "bot", text: r.answerable ? r.answer : "I can't find this in your documents. Try uploading whatever covers it, then ask again.", cite: cite ? `${cite.document.replace(/^uploads\//, "")}${cite.heading ? " · " + cite.heading : ""}` : undefined },
      ]);
      // Speak the reply aloud when voice is on; otherwise settle the orb.
      if (r.audio) playAudio(r.audio, () => setMode("muted"));
      else setTimeout(() => setMode("muted"), 2200);
    } catch (e) {
      setMessages((m) => [...m, { role: "bot", text: "Error: " + (e instanceof Error ? e.message : e) }]);
      setMode("muted");
    } finally {
      setBusy(false);
    }
  }

  async function verdict(id: number, v: "approved" | "rejected" | "ignored") {
    const item = queue.find((q) => q.id === id);
    try {
      const r = await api.verdict(id, v);
      if (r.sent) setMessages((m) => [...m, { role: "bot", text: `Reply sent to ${item?.from ?? "the sender"}.` }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "bot", text: "Couldn't send the reply: " + (e instanceof Error ? e.message : e) }]);
    }
    loadTriage();
  }

  const rankStyle = useMemo(() => (id: string) => {
    const rank = order.indexOf(id);
    if (rank === 0) return { transform: "translateZ(0)", opacity: 1, filter: "none", zIndex: 20 };
    // Non-focused windows sit faintly behind as a subtle depth hint, not readable
    // cards trailing below the (now content-sized) focused card.
    if (rank <= 2) return { transform: `translate(0, ${rank * 34}px) translateZ(-${rank * 48}px)`, opacity: 0.18 - rank * 0.07, filter: `blur(${1.5 + rank * 1.5}px)`, zIndex: 20 - rank };
    return { opacity: 0, pointerEvents: "none" as const };
  }, [order]);

  const suggestions = ["What are our net payment terms?", "Who represents the seller?", "What's in my inbox?", "What needs a reply?", "Summarize the contract"];

  // ---- live reasoning choreography ----
  // The rail shows the brain's real steps; captions show the sentence being
  // spoken; running searches/actions animate the focused card while they run.
  const rail = activity.filter((e) => e.kind !== "speak").slice(-7);
  const lastSpeak = [...activity].reverse().find((e) => e.kind === "speak");
  const caption = lastSpeak && nowMs - lastSpeak.at < 8000 ? lastSpeak.label : null;
  const scanning = activity.some(
    (e) => e.kind === "search" && e.state === "run" && nowMs - e.at < 3000 && !activity.some((r) => r.id > e.id && (r.kind === "sources" || r.kind === "result"))
  );
  const lastAction = [...activity].reverse().find((e) => e.kind === "action" && e.state === "run");
  const acting = !!lastAction && nowMs - lastAction.at < 6000 && !activity.some((r) => r.id > lastAction.id && r.kind === "result");
  const evGlyph = (e: UiEvent) =>
    e.kind === "route" ? "→" : e.kind === "search" ? "◎" : e.kind === "sources" ? "▤" : e.kind === "action" ? "⚡" : e.kind === "result" ? (e.state === "fail" ? "✕" : "✓") : "◈";

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
              {liveAnswer.citations.length > 0 && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {liveAnswer.citations.slice(0, 3).map((c) => (
                      <span key={c.n} className="cite"><span className="tag">SRC</span><span className="ref">{c.document.replace(/^uploads\//, "")}</span></span>
                    ))}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginTop: 14 }}>SOURCED · {liveAnswer.citations.length} CITATION{liveAnswer.citations.length === 1 ? "" : "S"}</div>
                </>
              )}
            </>
          ) : (
            <div style={{ borderLeft: "3px solid var(--warn)", paddingLeft: 12, color: "var(--mut)", fontSize: 14 }}>I can't find this in your documents.</div>
          )}
        </div>
      );
    }
    if (id === "inbox") {
      const d = queue[0];
      // Skip the focused email when it's the same one awaiting approval below.
      const fe = focusEmail && (!d || focusEmail.id !== d.id) ? focusEmail : null;
      if (!fe && !d) return <div style={{ color: "var(--mut2)", fontSize: 13, paddingTop: 8 }}>Inbox clear — Levi will draft replies as mail arrives.</div>;
      return (
        <div>
          {fe && (
            <div style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(var(--s5),0.5)", marginBottom: 10, border: fe.status === "compose" && !fe.sent_at ? "1px solid rgba(var(--accRGB),0.35)" : "none" }}>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>{fe.subject}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginBottom: 8 }}>
                {fe.status === "compose" ? <><span style={{ color: "var(--lab)" }}>NEW EMAIL</span> · to {fe.from_addr}</> : <>from {fe.from_addr}{fe.received_at ? " · " + fe.received_at.slice(0, 10) : ""}</>}
                {fe.sent_at ? <span style={{ color: "var(--ok)" }}> · {fe.status === "compose" ? "SENT" : "REPLIED"} {fe.sent_at.slice(0, 10)}</span> : null}
              </div>
              {fe.body && <div style={{ fontSize: 12.5, color: "var(--mut)", lineHeight: 1.55, maxHeight: 150, overflowY: "auto" }}>{fe.body}</div>}
              {fe.draft_reply && !fe.sent_at && (
                <div style={{ marginTop: fe.body ? 8 : 0, paddingTop: fe.body ? 8 : 0, borderTop: fe.body ? "1px solid rgba(var(--lineRGB),0.12)" : "none", fontSize: 12, color: fe.status === "compose" ? "var(--mut)" : "var(--mut2)", lineHeight: 1.5, maxHeight: fe.status === "compose" ? 150 : 76, overflow: fe.status === "compose" ? "auto" : "hidden" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.08em", color: "var(--lab)" }}>{fe.status === "compose" ? "AWAITING YOUR GO-AHEAD · " : "DRAFT · "}</span>
                  {fe.draft_reply}
                </div>
              )}
            </div>
          )}
          {d && (
            <>
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
            </>
          )}
        </div>
      );
    }
    if (id === "tasks") {
      const left = tasks.filter((t) => !t.done).length;
      return (
        <div>
          {tasks.length === 0 && <div style={{ color: "var(--mut2)", fontSize: 13, marginBottom: 10 }}>No tasks yet. Add one below.</div>}
          {tasks.map((t) => (
            <div key={t.id} onClick={() => toggleTask(t)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 2px", cursor: "pointer" }}>
              <span style={{ width: 19, height: 19, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${t.done ? "var(--acc)" : "rgba(var(--lineRGB),0.3)"}`, background: t.done ? "rgba(var(--accRGB),0.15)" : "transparent" }}>
                {t.done ? <Icon.check size={11} /> : null}
              </span>
              <span style={{ fontSize: 14, textDecoration: t.done ? "line-through" : "none", color: t.done ? "var(--mut2)" : "var(--tx)" }}>{t.title}</span>
            </div>
          ))}
          <input onKeyDown={(e) => e.key === "Enter" && addItem("task", (e.target as HTMLInputElement).value)} placeholder="Add a task…" style={addInput} />
          {tasks.length > 0 && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginTop: 8 }}>{left} LEFT</div>}
        </div>
      );
    }
    if (id === "schedule") {
      return (
        <div>
          {events.length === 0 && <div style={{ color: "var(--mut2)", fontSize: 13, marginBottom: 10 }}>No events. Add one as "9:30 Standup".</div>}
          {events.map((ev) => (
            <div key={ev.id} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "8px 0", borderLeft: "2px solid var(--acc)", paddingLeft: 12, marginBottom: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accM)", width: 50 }}>{ev.at ?? "—"}</span>
              <span style={{ fontSize: 15 }}>{ev.title}</span>
            </div>
          ))}
          <input onKeyDown={(e) => { const v = (e.target as HTMLInputElement).value; if (e.key === "Enter" && v.trim()) { const m = v.match(/^(\d{1,2}:\d{2})\s+(.+)/); addItem("event", m ? m[2] : v, m ? m[1] : undefined); } }} placeholder='Add "9:30 Standup"…' style={addInput} />
        </div>
      );
    }
    if (id === "notes") {
      return (
        <div>
          {notes.length === 0 && <div style={{ color: "var(--mut2)", fontSize: 13, marginBottom: 10 }}>No notes yet.</div>}
          {notes.map((n) => (
            <div key={n.id} style={{ fontSize: 14, padding: "7px 0", borderBottom: "1px dashed rgba(var(--lineRGB),0.1)" }}>{n.title}</div>
          ))}
          <input onKeyDown={(e) => e.key === "Enter" && addItem("note", (e.target as HTMLInputElement).value)} placeholder="Jot a note…" style={addInput} />
        </div>
      );
    }
    if (id === "contract") {
      if (redlinesBusy) return <div style={{ color: "var(--mut2)", display: "flex", gap: 10, alignItems: "center", paddingTop: 8 }}><span className="spin" /> Reviewing your contract…</div>;
      if (!redlines) return (
        <div>
          <div style={{ color: "var(--mut2)", fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>Levi reviews the most recent contract in your documents and proposes clause-level redlines.</div>
          <div onClick={runRedlines} style={{ display: "inline-block", padding: "9px 16px", borderRadius: 11, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, background: "linear-gradient(135deg,var(--acc),var(--acc2))", color: "var(--onAcc)" }}>RUN REDLINE REVIEW</div>
        </div>
      );
      if ((redlines as any).error) return <div style={{ color: "var(--mut)", fontSize: 13 }}>{(redlines as any).error}</div>;
      return (
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mut2)", marginBottom: 10 }}>{redlines.document.replace(/^uploads\//, "")} · {redlines.redlines.length} REDLINE{redlines.redlines.length === 1 ? "" : "S"}</div>
          <div style={{ maxHeight: 250, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {redlines.redlines.map((r, i) => (
              <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(var(--s5),0.5)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accM)", marginBottom: 5 }}>{r.clause}</div>
                <div style={{ fontSize: 12.5, color: "var(--mut)", marginBottom: 6 }}>{r.concern}</div>
                <div style={{ fontSize: 12.5, color: "var(--bad)", textDecoration: "line-through", marginBottom: 3 }}>{r.old_text.slice(0, 140)}</div>
                <div style={{ fontSize: 12.5, color: "var(--ok)" }}>{r.suggested_text.slice(0, 160)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return windowContent(id);
  }

  const addInput: CSSProperties = { width: "100%", marginTop: 10, padding: "8px 11px", borderRadius: 8, background: "rgba(var(--s5),0.5)", border: "1px solid rgba(var(--lineRGB),0.12)", color: "var(--tx)", fontFamily: "var(--sans)", fontSize: 13, outline: "none" };
  const inboxCount = queue.length;

  if (authed === false) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg,#1d1813,#0e0c0a)" }}>
        <div style={{ width: 420, padding: 30, borderRadius: 16, background: "rgba(44,38,32,0.9)", border: "1px solid rgba(255,235,215,0.1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 8 }}>
            <svg viewBox="113 221 131 157" style={{ width: 26, height: 31 }}><path d={FLAME} fill="#f55911" fillRule="evenodd" /></svg>
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
        <svg viewBox="113 221 131 157" style={{ width: 34, height: 41, marginBottom: 18 }}><path d={FLAME} fill="var(--acc)" fillRule="evenodd" /></svg>
        {[["chat", "chat"], ["schedule", "calendar"], ["docs", "file"], ["tasks", "check"]].map(([id, ic]) => {
          const I = Icon[ic as keyof typeof Icon];
          return <div key={id} className={"rail-nav" + (nav === id ? " active" : "")} onClick={() => setNav(id)}><I /></div>;
        })}
        <div className="rail-avatar">{(tenant[0] ?? "A").toUpperCase()}</div>
      </div>

      <div className="center">
        <div className="topbar">
          <div className="brand">
            <svg viewBox="113 221 131 157" style={{ width: 22, height: 26 }}><path d={FLAME} fill="var(--acc)" fillRule="evenodd" /></svg>
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
            {voiceReady && (
              <span className={"pill" + (speakReplies ? " on" : "")} onClick={() => setSpeakReplies((s) => !s)} title="Levi speaks replies aloud">
                {speakReplies ? <Icon.volume size={13} /> : <Icon.mute size={13} />} {speakReplies ? "VOICE" : "MUTED"}
              </span>
            )}
            <span className={"pill" + (auto ? " on" : "")} onClick={() => setAuto((a) => !a)}><span className="dot" /> {auto ? "AUTO" : "MANUAL"}</span>
          </div>
        </div>

        <div className="stage">
          <Orb
            theme={theme}
            mode={mode}
            level={level}
            idleLabel={voiceReady ? (speakReplies ? "READY" : "MUTED") : "READY"}
            caption={
              reconnecting ? (
                <span className="cap reconnect">
                  <span className="spin" style={{ width: 11, height: 11 }} /> Levi is updating, reconnecting…
                </span>
              ) : caption ? (
                <span className="cap">{caption}</span>
              ) : null
            }
          />
          {rail.length > 0 && (
            <div className="activity">
              <div className="act-head">LIVE REASONING</div>
              {rail.map((e) => (
                <div key={e.id} className={"act-line" + (e.state ? " " + e.state : "")} style={{ opacity: nowMs - e.at > 14000 ? 0.35 : 1 }}>
                  <span className="ic">{evGlyph(e)}</span>
                  <span>
                    {e.label}
                    {typeof e.n === "number" ? <span className="n"> · {e.n}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="window-stack" style={{ transformStyle: "preserve-3d" }}>
            {WINDOWS.map((w) => (
              <div
                key={w.id}
                className={"card" + (order[0] === w.id ? " focused" + (scanning ? " scanning" : "") + (acting ? " acting" : "") : "")}
                style={rankStyle(w.id)}
                onClick={() => promote(w.id)}
              >
                <div className="card-head">
                  <span className="card-chip">{(() => { const I = Icon[w.icon]; return <I size={15} />; })()}</span>
                  <span className="card-label">{w.label}</span>
                  <span className="card-meta">{w.tier === "preview" ? "PREVIEW" : w.id === "inbox" && inboxCount ? `${inboxCount} AWAITING` : w.meta ?? ""}</span>
                </div>
                <div className="card-body">{renderWindow(w.id)}</div>
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
            {liveReady && <span className={"mic" + (liveOn ? " on" : "")} onClick={toggleLive} title={liveOn ? "End conversation" : "Talk to Levi"}><Icon.mic size={18} /></span>}
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
