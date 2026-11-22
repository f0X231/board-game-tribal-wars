---
name: nextjs-board-ui
description: Frontend UI components using Next.js (App Router), React, TypeScript, and Tailwind CSS for the Aztec-themed match lobby, Snake Draft placement, responsive 6x6/10x10/12x12 grid board, and 3-step turn interaction.
---

# Tribal Wars - Next.js Frontend UI Guidelines

When building or modifying UI components in `/client` (Next.js App Router + Tailwind CSS v4), follow these rules. Read `client/AGENTS.md` first: this Next.js version differs from older docs; check `client/node_modules/next/dist/docs/` before using unfamiliar APIs.

## 1. Project Structure & Imports
- Import engine types and helpers from `@shared/gameEngine` (tsconfig path alias → `../shared`; `next.config.ts` sets `turbopack.root` to the repo root). Never re-implement rules in the client.
- `src/lib/useLocalMatch.ts`: reducer holding engine `GameState` + local `TurnStep` + battle log; exposes `getHints(pos)`, `clickCell(pos)`, `start(config)`, `cancel()`.
- `src/lib/tribes.ts`: tribe metadata (`TRIBES`) and `coord()` labels (`A1` = row 0, col 0).
- `src/components/`: `TribalWarsApp` (lobby ↔ match), `Lobby`, `MatchScreen`, `Board`, `Hud` (`PhaseBanner`, `TribeRoster`, `BattleLog`), `VictoryModal`, `art.tsx` (SVG `Totem`, `FireToken`, `Torch`, `Spear`, `ArrowGlyph`, plus `ArtDefs`).
- Interactive components and hooks must start with `'use client'`. `createGame` (and its `Math.random` for random spawn) must only run in client event handlers / lazy reducer init, never during SSR render.

## 2. Aztec Tribal Art Direction
- **Frame**: dark stone/charcoal `#1c1917` (`.stone-frame`) with a gold stepped fret band, corner torches, and spear accents.
- **Tiles**: alternating warm terracotta/ochre `#b4653c` (`.tile-ochre`) and obsidian `#292524` (`.tile-obsidian`), each with a circular carved-stone motif (`.tile::before`).
- **Tribes** (`P1`–`P4`), rendered as 3D carved SVG totems with a tribe-specific headdress:
  | Player | Tribe | Color | Headdress |
  |---|---|---|---|
  | `P1` | Aztec Tribe | Crimson Red `#b91c1c` | sun-feather fan |
  | `P2` | Maya Tribe | Emerald Green `#047857` | stepped-pyramid crown |
  | `P3` | Eagle Tribe | Amber Gold `#d97706` | spread wings + beak |
  | `P4` | Big Bear Tribe | Sapphire Blue `#1d4ed8` | round ears + snout |
- **Fire**: `FIRE` tiles render as gold-rimmed circular ember tokens with an animated flame (`.flame`, `.ember-glow`); fresh fires play `.ignite`.
- Shared SVG gradients live once in `<ArtDefs />` (ids `tw-body-P1`, `tw-gold`, `tw-ember`, …). Reuse them instead of adding per-element `<defs>`.
- Fonts: Cinzel (`font-display`) for headings/labels, Geist for body text. Respect `prefers-reduced-motion` for all new animations.

## 3. Match Setup Lobby
- Styled as a parchment ritual scroll (`.parchment`, `.scroll-rod`).
- Options: `boardSize` (`6`, `10`, `12`), `playerCount` (`2`–`4`), `piecesPerPlayer` (only the legal range from `getPieceLimits`; clamp when the board size changes), `placementMode` (`MANUAL` "Manual Snake Draft" / `RANDOM` "Quick Random Spawn").
- Validate with `validateConfig` before enabling "Begin the Ritual".

## 4. Responsive Grid Rendering
- CSS Grid with **both** `gridTemplateColumns` and `gridTemplateRows` set to `repeat(boardSize, minmax(0, 1fr))` inside an `aspect-square` container (frame `max-w-[650px] w-full`); without explicit rows, rows collapse to content height.
- Cells must scale cleanly across `6x6`, `10x10`, and `12x12` down to a 390px-wide phone with no horizontal scroll. Show column letters and row numbers around the board.
- Each cell is a `<button role="gridcell">` with a descriptive `aria-label`.

## 5. Interaction UX
### `phase === 'PLACEMENT'` (Snake Draft)
- Show the drafting tribe in the banner, "Raise a totem (n of total)", and each tribe's remaining totems (`getPiecesToPlace`).
- Empty squares show a ghost totem of the current tribe on hover/focus; clicking calls `placePiece`.
- When the draft ends, log who places last and therefore strikes first.

### `phase === 'PLAYING'` (3-step turn)
- **`SELECT_PIECE`**: pulse-highlight (`.movable`) only the current tribe's pieces that have at least one complete legal action (from `getValidActions`).
- **`SELECT_MOVE`**: show glowing emerald/gold runes (`.move-rune`) on valid `to` squares. Clicking another movable own piece switches selection; clicking the selected piece deselects.
- **`SELECT_SHOOT`**: preview the totem at `to` and a burning fire token on the vacated `from`; highlight valid `shoot` targets in fiery orange/red (`.shoot-target` + arrow glyph). Offer "Cancel Move" to return to `SELECT_PIECE`. Only target clicks are accepted in this step.

## 6. HUD & Match Controls
- Phase badge (`PLACEMENT` / `BATTLE` / `FINISHED`), active tribe banner with step instructions, tribe roster (totems that can still fight, to-place count, eliminated state), live battle log (also the place for the AI reasoning feed in Phase 3), "Reset" and "Back to Lobby" buttons.
- Victory modal headed "FIGHT FOR YOUR TRIBE" with the winning tribe's totem, fallen tribes, and "Rematch" / "Lobby".

## 7. Verification
- Run `npx tsc --noEmit`, `npm run lint`, and `npm run build` in `/client` after UI changes, and check the result in a real browser (desktop + ~390px mobile) when layout or interaction changes.
