import type { PlayerId, Position } from "@shared/gameEngine";

export interface Tribe {
  id: PlayerId;
  name: string;
  short: string;
  /** Main carved-wood tone. */
  base: string;
  /** Highlight (lit side). */
  light: string;
  /** Shadow side. */
  dark: string;
  /** Text-safe accent on dark backgrounds. */
  accent: string;
}

export const TRIBES: Record<PlayerId, Tribe> = {
  P1: { id: "P1", name: "Aztec Tribe", short: "Aztec", base: "#b91c1c", light: "#f87171", dark: "#5f1212", accent: "#fca5a5" },
  P2: { id: "P2", name: "Maya Tribe", short: "Maya", base: "#047857", light: "#34d399", dark: "#053d2e", accent: "#6ee7b7" },
  P3: { id: "P3", name: "Eagle Tribe", short: "Eagle", base: "#d97706", light: "#fcd34d", dark: "#6b3a0c", accent: "#fcd34d" },
  P4: { id: "P4", name: "Big Bear Tribe", short: "Big Bear", base: "#1d4ed8", light: "#7aa7ff", dark: "#172a6b", accent: "#93c5fd" },
};

/** Board coordinate label, e.g. {row:0,col:2} -> "C1". */
export function coord(p: Position): string {
  return `${String.fromCharCode(65 + p.col)}${p.row + 1}`;
}
