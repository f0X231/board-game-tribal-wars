"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALL_PLAYERS,
  BOARD_SIZES,
  getPieceLimits,
  validateConfig,
  type BoardSize,
  type GameConfig,
  type PlacementMode,
  type PlayerCount,
  type PlayerId,
} from "@shared/gameEngine";
import { CUSTOM_MODEL_ID_PATTERN, type LlmProvider, type ModelInfo, type ModelsResponse } from "@shared/apiTypes";
import { API_URL, LOCAL_BOTS, fetchModels } from "@/lib/api";
import { AI_DELAY_OPTIONS, HUMAN, type MatchConfig, type SlotController } from "@/lib/matchConfig";
import { TRIBES } from "@/lib/tribes";
import { Totem } from "./art";

interface LobbyProps {
  initial: MatchConfig;
  onStart: (config: MatchConfig) => void;
}

type ServerStatus =
  | { state: "loading" }
  | { state: "online"; catalog: ModelsResponse; refreshing: boolean }
  | { state: "offline"; error: string };

const CUSTOM = "__custom__";
const PROVIDER_LABEL: Record<LlmProvider, string> = { groq: "Groq", openrouter: "OpenRouter" };

/** Option-group label: "Groq (Live Free Models)", or "(curated list)" when live discovery failed. */
function groupLabel(provider: ModelInfo["provider"], catalog: ModelsResponse | null): string {
  if (provider === "offline") return "Built-in Offline Bots";
  const d = catalog?.discovery?.[provider];
  const kind = !d || d.status === "live" ? "Live Free Models" : d.status === "fallback" ? "Curated list · discovery offline" : "needs API key";
  return `${PROVIDER_LABEL[provider]} (${kind})`;
}

const PROVIDER_ORDER: ReadonlyArray<ModelInfo["provider"]> = ["offline", "groq", "openrouter"];

/** Inline "Custom Model ID" editor: provider + model id typed by hand (for newly released models). */
function CustomModelForm({
  tribeName,
  providers,
  initial,
  onUse,
  onCancel,
}: {
  tribeName: string;
  providers: Record<LlmProvider, boolean>;
  initial: string;
  onUse: (slot: SlotController) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<LlmProvider>(initial.startsWith("openrouter:") ? "openrouter" : providers.groq ? "groq" : "openrouter");
  const [model, setModel] = useState(initial.replace(/^(groq|openrouter):/, ""));
  const id = `${provider}:${model.trim()}`;
  const valid = model.trim().length > 0 && CUSTOM_MODEL_ID_PATTERN.test(id);
  const enabled = providers[provider];
  const submit = () => {
    if (valid && enabled) onUse({ type: "ai", modelId: id, label: `${model.trim()} (custom)` });
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[#7c2d12]/50 bg-white/30 p-2">
      <select
        aria-label={`${tribeName} custom model provider`}
        value={provider}
        onChange={(e) => setProvider(e.target.value as LlmProvider)}
        className="rounded border border-ink/30 bg-[#f5e7c4] px-1.5 py-1 text-xs font-semibold text-ink"
      >
        <option value="groq">Groq{providers.groq ? "" : " (no key)"}</option>
        <option value="openrouter">OpenRouter{providers.openrouter ? "" : " (no key)"}</option>
      </select>
      <input
        aria-label={`${tribeName} custom model id`}
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={provider === "groq" ? "e.g. openai/gpt-oss-120b" : "e.g. vendor/model:free"}
        spellCheck={false}
        className="min-w-0 flex-1 rounded border border-ink/30 bg-[#fdf6e3] px-2 py-1 font-mono text-xs text-ink placeholder:text-ink/40 focus:border-[#7c2d12] focus:outline-none"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!valid || !enabled}
        className="rounded border border-[#7c2d12] bg-[#7c2d12] px-2.5 py-1 text-xs font-bold text-[#fde68a] disabled:opacity-40"
      >
        Use
      </button>
      <button type="button" onClick={onCancel} className="rounded px-1.5 py-1 text-xs font-semibold text-ink/70 hover:text-ink">
        Cancel
      </button>
      {model.trim().length > 0 && !valid && <p className="w-full text-[11px] text-red-800">Letters, digits and . _ - / : only.</p>}
      {!enabled && <p className="w-full text-[11px] text-red-800">Add the {PROVIDER_LABEL[provider]} API key to server/.env first.</p>}
    </div>
  );
}

function SeatPicker({
  player,
  slot,
  models,
  catalog,
  onChange,
}: {
  player: PlayerId;
  slot: SlotController;
  models: ModelInfo[];
  catalog: ModelsResponse | null;
  onChange: (slot: SlotController) => void;
}) {
  const tribe = TRIBES[player];
  const [editing, setEditing] = useState(false);
  const value = slot.type === "human" ? "human" : slot.modelId;
  const isCustom = slot.type === "ai" && !models.some((m) => m.id === slot.modelId);
  return (
    <div className="rounded-lg border border-ink/20 bg-white/25 px-3 py-2">
      <div className="flex items-center gap-3">
        <Totem tribe={player} className="h-10 w-10 shrink-0" />
        <span className="font-display w-24 shrink-0 text-sm font-bold sm:w-28" style={{ color: tribe.dark }}>
          {tribe.name}
        </span>
        <select
          aria-label={`${tribe.name} controller`}
          value={editing ? CUSTOM : value}
          onChange={(e) => {
            const id = e.target.value;
            if (id === CUSTOM) return setEditing(true);
            setEditing(false);
            if (id === "human") return onChange(HUMAN);
            const m = models.find((x) => x.id === id);
            if (m) onChange({ type: "ai", modelId: m.id, label: m.label });
          }}
          className="min-w-0 flex-1 rounded-md border-2 border-ink/30 bg-[#f5e7c4] px-2 py-1.5 text-sm font-semibold text-ink focus:border-[#7c2d12] focus:outline-none"
        >
          <option value="human">🧑 Human</option>
          {PROVIDER_ORDER.map((provider) => {
            const group = models.filter((m) => m.provider === provider);
            if (group.length === 0) return null;
            return (
              <optgroup key={provider} label={groupLabel(provider, catalog)}>
                {group.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available} title={m.description}>
                    🤖 {m.label}
                    {m.available ? "" : " — needs API key"}
                  </option>
                ))}
              </optgroup>
            );
          })}
          {catalog && (
            <optgroup label="Custom">
              {isCustom && slot.type === "ai" && <option value={slot.modelId}>✎ {slot.modelId}</option>}
              <option value={CUSTOM}>✎ Custom model ID…</option>
            </optgroup>
          )}
        </select>
      </div>
      {editing && catalog && (
        <CustomModelForm
          tribeName={tribe.name}
          providers={{ groq: catalog.providers.groq, openrouter: catalog.providers.openrouter }}
          initial={isCustom && slot.type === "ai" ? slot.modelId : ""}
          onUse={(next) => {
            setEditing(false);
            onChange(next);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<T>;
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink/80">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={String(opt)}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt)}
              className={`font-display min-w-14 rounded-md border-2 px-4 py-2 text-base font-bold transition ${
                active
                  ? "border-[#7c2d12] bg-[#7c2d12] text-[#fde68a] shadow-[inset_0_-3px_0_rgba(0,0,0,0.35)]"
                  : "border-ink/30 bg-white/25 text-ink hover:border-[#7c2d12]/70 hover:bg-white/40"
              }`}
            >
              {render ? render(opt) : String(opt)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** One-line summary of what the server discovered. */
function CatalogStatus({ catalog }: { catalog: ModelsResponse }) {
  const parts = (["groq", "openrouter"] as const).map((p) => {
    const d = catalog.discovery?.[p];
    if (!catalog.providers[p] || d?.status === "no-key") return `${PROVIDER_LABEL[p]}: no API key`;
    if (!d) return `${PROVIDER_LABEL[p]}: ready`;
    if (d.status === "live") return `${PROVIDER_LABEL[p]}: ${d.count} live free models`;
    return `${PROVIDER_LABEL[p]}: discovery failed (${d.error ?? "unknown"}), curated list`;
  });
  const anyKey = catalog.providers.groq || catalog.providers.openrouter;
  return (
    <>
      AI Arena server online. {parts.join(" · ")}.
      {!anyKey && " Add GROQ_API_KEY or OPENROUTER_API_KEY to server/.env to unlock LLM models."}
    </>
  );
}

export function Lobby({ initial, onStart }: LobbyProps) {
  const [boardSize, setBoardSize] = useState<BoardSize>(initial.boardSize);
  const [playerCount, setPlayerCount] = useState<PlayerCount>(initial.playerCount);
  const [pieces, setPieces] = useState<number>(initial.piecesPerPlayer);
  const [mode, setMode] = useState<PlacementMode>(initial.placementMode ?? "MANUAL");
  const [slots, setSlots] = useState<Record<PlayerId, SlotController>>(initial.slots);
  const [aiDelayMs, setAiDelayMs] = useState<number>(initial.aiDelayMs);
  const [server, setServer] = useState<ServerStatus>({ state: "loading" });

  const inflight = useRef<AbortController | null>(null);
  const request = useCallback((refresh: boolean) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    fetchModels(controller.signal, refresh)
      .then((catalog) => setServer({ state: "online", catalog, refreshing: false }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setServer({ state: "offline", error: err instanceof Error ? err.message : "unreachable" });
      });
  }, []);
  /** "Refresh Models": asks the server to re-discover live free models (bypasses its 15-min cache). */
  const loadModels = (refresh: boolean) => {
    setServer((s) => (s.state === "online" ? { ...s, refreshing: true } : { state: "loading" }));
    request(refresh);
  };

  useEffect(() => {
    request(false);
    return () => inflight.current?.abort();
  }, [request]);

  const catalog = server.state === "online" ? server.catalog : null;
  const models = catalog ? catalog.models : LOCAL_BOTS;
  const seated = ALL_PLAYERS.slice(0, playerCount);
  const anyAi = seated.some((p) => slots[p].type === "ai");
  const allAi = seated.every((p) => slots[p].type === "ai");

  const limits = getPieceLimits(boardSize);
  const pieceOptions = Array.from({ length: limits.max - limits.min + 1 }, (_, i) => limits.min + i);

  const changeBoard = (size: BoardSize) => {
    setBoardSize(size);
    const l = getPieceLimits(size);
    setPieces((p) => Math.min(l.max, Math.max(l.min, p)));
  };

  const gameConfig: GameConfig = { boardSize, playerCount, piecesPerPlayer: pieces, placementMode: mode };
  const errors = validateConfig(gameConfig);
  // Seats whose chosen model is not offered (e.g. server went offline) fall back to the heuristic bot.
  const resolvedSlots = Object.fromEntries(
    ALL_PLAYERS.map((p) => {
      const slot = slots[p];
      const custom = slot.type === "ai" && catalog !== null && CUSTOM_MODEL_ID_PATTERN.test(slot.modelId) && !models.some((m) => m.id === slot.modelId);
      const customOk = custom && slot.type === "ai" && catalog.providers[slot.modelId.startsWith("groq:") ? "groq" : "openrouter"];
      if (slot.type === "ai" && !customOk && !models.some((m) => m.id === slot.modelId && m.available)) {
        return [p, { type: "ai", modelId: "offline:heuristic", label: "Heuristic Shaman" } satisfies SlotController];
      }
      return [p, slot];
    }),
  ) as Record<PlayerId, SlotController>;
  const config: MatchConfig = { ...gameConfig, slots: resolvedSlots, aiDelayMs };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <div className="scroll-rod mx-[-12px] h-5 rounded-full" />
      <section className="parchment relative px-6 py-8 sm:px-12 sm:py-10">
        <header className="text-center">
          <p className="font-display text-xs font-bold uppercase tracking-[0.45em] text-[#7c2d12]">The Ritual of Fire</p>
          <h1 className="font-display mt-2 text-4xl font-black tracking-wide text-ink sm:text-5xl">Tribal Wars</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink/80">
            Move like a queen, leave fire in your wake, and loose a burning arrow every turn. The last tribe that can still
            fight claims the land.
          </p>
        </header>

        <div className="my-6 flex items-end justify-center gap-3 sm:gap-6">
          {ALL_PLAYERS.map((p, i) => {
            const joined = i < playerCount;
            return (
              <div key={p} className={`flex flex-col items-center transition ${joined ? "" : "opacity-30 grayscale"}`}>
                <Totem tribe={p} className="h-14 w-14 sm:h-16 sm:w-16" />
                <span className="font-display mt-1 text-[11px] font-bold" style={{ color: TRIBES[p].dark }}>
                  {TRIBES[p].short}
                </span>
              </div>
            );
          })}
        </div>

        <div className="space-y-6">
          <Segmented
            label="Battleground"
            value={boardSize}
            options={BOARD_SIZES}
            onChange={changeBoard}
            render={(v) => `${v} × ${v}`}
          />
          <Segmented label="Tribes" value={playerCount} options={[2, 3, 4] as const} onChange={setPlayerCount} />
          <fieldset>
            <legend className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink/80">Tribe seats</legend>
            <div className="space-y-2">
              {seated.map((p) => (
                <SeatPicker
                  key={p}
                  player={p}
                  slot={resolvedSlots[p]}
                  models={models}
                  catalog={catalog}
                  onChange={(slot) => setSlots((s) => ({ ...s, [p]: slot }))}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs text-ink/70" role="status">
                {server.state === "loading" && "Contacting the AI Arena server…"}
                {server.state === "online" && <CatalogStatus catalog={server.catalog} />}
                {server.state === "offline" && `AI Arena server unreachable at ${API_URL}. Built-in bots will run in your browser.`}
              </p>
              {server.state !== "loading" && (
                <button
                  type="button"
                  onClick={() => loadModels(true)}
                  disabled={server.state === "online" && server.refreshing}
                  className="shrink-0 rounded-md border border-ink/30 bg-white/30 px-2.5 py-1 text-xs font-bold text-ink transition hover:border-[#7c2d12]/70 hover:bg-white/50 disabled:opacity-50"
                >
                  {server.state === "online" && server.refreshing ? "Refreshing…" : "⟳ Refresh Models"}
                </button>
              )}
            </div>
            {allAi && <p className="mt-1 text-xs font-semibold text-[#7c2d12]">Spectator mode: every tribe is an AI. Sit back and watch.</p>}
          </fieldset>
          {anyAi && (
            <Segmented
              label="AI turn speed"
              value={aiDelayMs}
              options={AI_DELAY_OPTIONS.map((o) => o.ms)}
              onChange={setAiDelayMs}
              render={(ms) => AI_DELAY_OPTIONS.find((o) => o.ms === ms)?.label ?? `${ms}ms`}
            />
          )}
          <Segmented
            label={`Totems per tribe (${limits.min}–${limits.max} on ${boardSize}×${boardSize})`}
            value={pieces}
            options={pieceOptions}
            onChange={setPieces}
          />
          <fieldset>
            <legend className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink/80">Totem placement</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["MANUAL", "Manual Snake Draft", "Tribes take turns raising one totem at a time in snake order. The last to place strikes first."],
                  ["RANDOM", "Quick Random Spawn", "The draft is completed for you at random. Jump straight into battle."],
                ] as const
              ).map(([value, title, desc]) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMode(value)}
                    className={`rounded-lg border-2 p-3 text-left transition ${
                      active ? "border-[#7c2d12] bg-[#7c2d12]/10 shadow-[inset_0_0_0_1px_#7c2d12]" : "border-ink/25 bg-white/20 hover:border-[#7c2d12]/60"
                    }`}
                  >
                    <span className="font-display block font-bold text-ink">{title}</span>
                    <span className="mt-1 block text-xs leading-snug text-ink/75">{desc}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {errors.length > 0 && <p className="mt-4 text-sm font-semibold text-red-800">{errors.join(" ")}</p>}

        <button
          type="button"
          disabled={errors.length > 0}
          onClick={() => onStart(config)}
          className="font-display mt-8 w-full rounded-lg border-2 border-[#451a03] bg-gradient-to-b from-[#b45309] via-[#9a3412] to-[#7c2d12] px-6 py-4 text-lg font-black uppercase tracking-[0.25em] text-[#fde68a] shadow-[0_6px_0_#451a03,0_10px_20px_rgba(0,0,0,0.35)] transition hover:brightness-110 active:translate-y-1 active:shadow-[0_2px_0_#451a03] disabled:opacity-50"
        >
          Begin the Ritual
        </button>
      </section>
      <div className="scroll-rod mx-[-12px] h-5 rounded-full" />
    </div>
  );
}
