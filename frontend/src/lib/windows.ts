import { Icon } from "./icons";

// The 12 windows. tier "real" = wired to a backend (or will be in L4/L5);
// tier "preview" = labeled, non-functional stub (ADR-013).
export interface WindowDef {
  id: string;
  label: string;
  dockLabel: string;
  icon: keyof typeof Icon;
  tier: "real" | "preview";
  meta?: string;
}

export const WINDOWS: WindowDef[] = [
  { id: "answer", label: "DOCS · ANSWER", dockLabel: "Answer", icon: "file", tier: "real", meta: "SOURCED" },
  { id: "inbox", label: "INBOX · MAIL", dockLabel: "Inbox", icon: "mail", tier: "real" },
  { id: "schedule", label: "TODAY · SCHEDULE", dockLabel: "Schedule", icon: "calendar", tier: "real" },
  { id: "tasks", label: "TASKS", dockLabel: "Tasks", icon: "check", tier: "real" },
  { id: "notes", label: "NOTES · MEETING PREP", dockLabel: "Prep", icon: "note", tier: "real" },
  { id: "flight", label: "FLIGHT", dockLabel: "Flight", icon: "plane", tier: "preview" },
  { id: "lunch", label: "LUNCH · YOUR USUAL", dockLabel: "Lunch", icon: "coffee", tier: "preview" },
  { id: "code", label: "CODE · PR #412", dockLabel: "Code PR", icon: "code", tier: "preview" },
  { id: "sheet", label: "SHEET", dockLabel: "Sheet", icon: "grid", tier: "preview" },
  { id: "contract", label: "CONTRACT · REDLINES", dockLabel: "Contract", icon: "edit", tier: "real" },
  { id: "ambient", label: "AMBIENT · WEATHER & WATCHLIST", dockLabel: "Weather", icon: "cloud", tier: "preview" },
  { id: "slack", label: "SLACK", dockLabel: "Slack", icon: "hash", tier: "preview" },
];
