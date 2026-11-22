# CLAUDE.md - Tribal Wars (AI Arena & Online Strategy)

This file provides project context, architectural guidelines, and strict game rules for AI coding assistants working on this repository.

## 1. Project Overview
**Tribal Wars** is a turn-based, grid-based tactical strategy board game featuring permanent fire hazards, online multiplayer (2–4 players), and an AI Arena where users can play against or spectate matches between free open-source LLM models.

## 2. Tech Stack & Monorepo Structure
The project uses a Full-Stack TypeScript architecture divided into three directories at the root:
- **`/client`**: Frontend web app built with **Next.js (App Router)**, **React**, **TypeScript**, and **Tailwind CSS**. Handles the match setup lobby, board rendering, move/shoot highlights, and turn animations.
- **`/server`**: Backend game server built with **Node.js**, **Express**, **TypeScript**, and **Socket.IO**. Acts as the authoritative game state validator, manages online rooms, and interfaces with external LLM APIs via the OpenAI-compatible SDK.
- **`/shared`**: Pure TypeScript game engine, types, and rule validation logic shared between `/client` and `/server`. Must remain framework-agnostic with zero UI dependencies.

## 3. Core Game Rules (Strictly Enforce)
1. **Board Sizes & Piece Allocation**:
   - Players per match: **2, 3, or 4** (Human or AI).
   - Board size **6x6**: Each player selects **2 to 4 pieces**.
   - Board size **10x10** or **12x12**: Each player selects **4 to 6 pieces** (maximum 6 pieces per player).
   - Tribes: `P1` = Aztec (crimson), `P2` = Maya (emerald), `P3` = Eagle (amber), `P4` = Big Bear (sapphire).
2. **Totem Placement (Snake Draft) — `phase: 'PLACEMENT'`**:
   - A match starts on an empty board. Players place **1 totem at a time** on any `EMPTY` square in **snake order** (forward, then reversed, alternating each round; e.g. 3 players: `P1 → P2 → P3 → P3 → P2 → P1 → ...`) until everyone has placed `piecesPerPlayer` totems.
   - **First Mover Rule**: the player who placed the **very last totem** moves first when `phase` becomes `'PLAYING'`; play then proceeds clockwise (`P1 → P2 → P3 → P4`).
   - `placementMode: 'RANDOM'` auto-completes the same snake draft on random empty squares (first-mover rule still applies). `'MANUAL'` is the default.
   - No moves or arrows are allowed during placement; no placements are allowed after it.
3. **Turn Sequence (3 Mandatory Steps) — `phase: 'PLAYING'`**:
   - **Step 1 - Move**: Select one of the player's pieces and move it any number of unobstructed squares orthogonally or diagonally (like a Chess Queen). Cannot jump over or land on other pieces or fire tiles.
   - **Step 2 - Leave Fire Trail**: The exact square the piece just vacated immediately ignites into a **permanent Fire tile**.
   - **Step 3 - Shoot Fire Arrow**: From the newly arrived destination square, shoot a fire arrow in any Queen direction (orthogonal/diagonal) any number of unobstructed squares. The arrow cannot pass through pieces or existing fire tiles. The square where the arrow stops becomes a **permanent Fire tile**.
4. **Fire Mechanics**:
   - All fire tiles (both from movement trails and fire arrows) are **permanent** until the match ends.
   - Fire tiles act as impassable obstacles for both movement and fire arrows. No player can ever step on or shoot through any fire tile.
5. **Elimination & Win Condition**:
   - A player is **eliminated** immediately if, at the start of their turn, none of their pieces can make a complete valid turn (must be able to both move AND shoot a fire arrow afterward).
   - The last remaining active player wins the match.

## 4. AI Integration Guidelines
- **Target Models**: Free open-source models (e.g., Llama, Qwen, Mistral, DeepSeek, Gemma) accessed via OpenAI-compatible free endpoints such as **OpenRouter (`:free` tier)** or **Groq**.
- **Preventing Illegal Moves**: Never ask an LLM to generate raw coordinates blindly. Always compute the list of legal `MoveAction` objects (`{ from, to, shoot }`) using the shared game engine first, pass the board state and valid action IDs/choices to the LLM, and require it to select a valid action ID.
- **Spectator Mode (AI vs AI)**: Include a configurable turn delay (e.g., 1000ms–2000ms) on the server when AI models play against each other so human spectators can visually follow the board state changes.

## 5. Development & Coding Conventions
- **Authoritative Server**: In online multiplayer matches, `/client` only emits player intent (`from`, `to`, `shoot`). `/server` must validate every move using `/shared/gameEngine.ts` before broadcasting the updated `GameState`.
- **Immutability**: Keep game state updates pure and immutable in `/shared` so state history, replays, and UI updates remain predictable.
- **Type Safety**: Maintain strict TypeScript types across `/shared`, `/client`, and `/server`. Avoid `any`.