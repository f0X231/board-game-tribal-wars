import type { GameConfig, PlayerId } from "@shared/gameEngine";

/** Who controls a tribe seat. */
export type SlotController = { type: "human" } | { type: "ai"; modelId: string; label: string };

export interface MatchConfig extends GameConfig {
  slots: Record<PlayerId, SlotController>;
  /** Minimum time each AI turn takes, so spectators can follow (ms). */
  aiDelayMs: number;
}

export const AI_DELAY_OPTIONS = [
  { ms: 500, label: "Fast · 0.5s" },
  { ms: 1200, label: "Normal · 1.2s" },
  { ms: 2500, label: "Slow · 2.5s" },
] as const;

export const HUMAN: SlotController = { type: "human" };

export function controllerLabel(slot: SlotController): string {
  return slot.type === "human" ? "Human" : slot.label;
}
