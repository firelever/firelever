// The 5 Levi themes, tokens lifted verbatim from the design prototype (THEMES map).
// Applied by writing every key as a CSS custom property on :root.
export type ThemeName = "ember" | "graphite" | "nebula" | "signal" | "ivory";

export const THEMES: Record<ThemeName, Record<string, string>> = {
  ember: { "--acc": "#ff9f0a", "--acc2": "#ff7a45", "--accL": "#ffd9a8", "--accM": "#ffbe66", "--lab": "#a09689", "--tx": "#f8f4ef", "--tx2": "#e3dbd1", "--mut": "#b5a99c", "--mut2": "#93887c", "--accRGB": "255,159,10", "--lineRGB": "255,235,215", "--acc2RGB": "255,122,69", "--s1": "44,38,32", "--s2": "37,32,27", "--s3": "30,26,22", "--s4": "22,19,16", "--s5": "17,15,13", "--bg1": "#1d1813", "--bg2": "#12100d", "--bg3": "#0e0c0a", "--onAcc": "#0e0c0a", "--shA": "0.45", "--hiA": "0.08", "--ok": "#6ee08a", "--okD": "#30d158", "--warn": "#ffd60a", "--orbShadow": "none", "--bad": "#ff7a76" },
  graphite: { "--acc": "#0a84ff", "--acc2": "#5e9eff", "--accL": "#a8ccff", "--accM": "#6eb0ff", "--lab": "#8f99a6", "--tx": "#f6f8fa", "--tx2": "#dde2e8", "--mut": "#a6afb9", "--mut2": "#87909b", "--accRGB": "10,132,255", "--lineRGB": "225,235,245", "--acc2RGB": "94,158,255", "--s1": "38,41,46", "--s2": "32,35,39", "--s3": "26,28,32", "--s4": "19,21,24", "--s5": "15,17,19", "--bg1": "#17191d", "--bg2": "#0f1114", "--bg3": "#0b0d0f", "--onAcc": "#0e0c0a", "--shA": "0.45", "--hiA": "0.08", "--ok": "#6ee08a", "--okD": "#30d158", "--warn": "#ffd60a", "--orbShadow": "none", "--bad": "#ff7a76" },
  nebula: { "--acc": "#bf5af2", "--acc2": "#7d7aff", "--accL": "#e2b8ff", "--accM": "#d18af7", "--lab": "#968fa9", "--tx": "#f7f5fb", "--tx2": "#e0dcea", "--mut": "#a8a2b8", "--mut2": "#89839a", "--accRGB": "191,90,242", "--lineRGB": "235,225,250", "--acc2RGB": "125,122,255", "--s1": "38,35,47", "--s2": "32,29,40", "--s3": "26,24,33", "--s4": "19,18,25", "--s5": "15,14,20", "--bg1": "#181521", "--bg2": "#0f0d15", "--bg3": "#0b0a10", "--onAcc": "#0e0c0a", "--shA": "0.45", "--hiA": "0.08", "--ok": "#6ee08a", "--okD": "#30d158", "--warn": "#ffd60a", "--orbShadow": "none", "--bad": "#ff7a76" },
  signal: { "--acc": "#66d4cf", "--acc2": "#64d2ff", "--accL": "#b8ece8", "--accM": "#8ae0da", "--lab": "#8a9d99", "--tx": "#f4f8f7", "--tx2": "#dbe6e4", "--mut": "#9fb2ae", "--mut2": "#829591", "--accRGB": "102,212,207", "--lineRGB": "220,245,242", "--acc2RGB": "100,210,255", "--s1": "30,38,37", "--s2": "25,32,31", "--s3": "20,27,26", "--s4": "14,20,19", "--s5": "11,16,15", "--bg1": "#121a19", "--bg2": "#0b110f", "--bg3": "#080d0c", "--onAcc": "#0e0c0a", "--shA": "0.45", "--hiA": "0.08", "--ok": "#6ee08a", "--okD": "#30d158", "--warn": "#ffd60a", "--orbShadow": "none", "--bad": "#ff7a76" },
  ivory: { "--acc": "#0a66c2", "--acc2": "#3b82d9", "--accL": "#0a5cb0", "--accM": "#0a66c2", "--lab": "#7a828e", "--tx": "#1a1d22", "--tx2": "#3a4048", "--mut": "#5c636d", "--mut2": "#8a919c", "--accRGB": "10,102,194", "--lineRGB": "25,35,50", "--acc2RGB": "59,130,217", "--s1": "255,255,255", "--s2": "250,250,251", "--s3": "243,244,246", "--s4": "255,255,255", "--s5": "249,249,250", "--bg1": "#eef0f3", "--bg2": "#e4e7eb", "--bg3": "#dde0e5", "--onAcc": "#ffffff", "--shA": "0.10", "--hiA": "0.9", "--ok": "#1f9d4d", "--okD": "#23a355", "--warn": "#b25e00", "--orbShadow": "drop-shadow(0 10px 22px rgba(10,102,194,0.30))", "--bad": "#c0392b" },
};

// Orb color trios per theme (base / highlight / secondary), from the ORB map.
export const ORB_COLORS: Record<ThemeName, [string, string, string]> = {
  ember: ["#ff9f0a", "#ffd9a8", "#ff7a45"],
  graphite: ["#0a84ff", "#a8ccff", "#5e9eff"],
  nebula: ["#bf5af2", "#e2b8ff", "#7d7aff"],
  signal: ["#66d4cf", "#b8ece8", "#64d2ff"],
  ivory: ["#0a66c2", "#5b9de0", "#3b82d9"],
};

export const THEME_ORDER: ThemeName[] = ["ember", "graphite", "nebula", "signal", "ivory"];

export function applyTheme(name: ThemeName) {
  const vars = THEMES[name];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = name;
  root.dataset.light = name === "ivory" ? "1" : "0";
}
