---
name: nextjs-board-ui
description: Frontend UI components using Next.js (App Router), React, TypeScript, and Tailwind CSS for the match lobby, responsive 6x6/10x10/12x12 grid board, and 3-step turn interaction.
---

# Tribal Wars - Next.js Frontend UI Guidelines

When building or modifying UI components in `/client` (Next.js App Router + Tailwind CSS), follow these rules:

## 1. Client vs Server Components
- Interactive game boards, Socket.IO listeners, and state hooks (`useState`, `useEffect`) must include `'use client'` at the top of the file.
- Keep game state rendering decoupled from business logic; always import types and validation helpers from `/shared`.

## 2. Responsive Grid Rendering
- Render the game board using CSS Grid (`grid-template-columns: repeat(boardSize, minmax(0, 1fr))`) inside a square aspect-ratio container (`aspect-square max-w-[650px] w-full`).
- Ensure cells scale cleanly across `6x6`, `10x10`, and `12x12` without overflowing the viewport.

## 3. Interactive 3-Step Turn UX
Guide the human player visually through the turn phases:
- **Phase 1 (`SELECT_PIECE`)**: Highlight all pieces belonging to `currentPlayer` that have at least one valid move.
- **Phase 2 (`SELECT_MOVE`)**: Once a piece is clicked, highlight valid destination squares (`to`) in green/emerald. Allow clicking another own piece to switch selection.
- **Phase 3 (`SELECT_SHOOT`)**: Once `to` is clicked, preview the piece at `to` and the vacated `from` square as burning fire, then highlight valid `shoot` target squares in orange/red. Include a "Cancel Move" button to reset back to Phase 1 before confirming.

## 4. Visual Clarity & Theme
- Use distinct, high-contrast colors/icons for `P1`, `P2`, `P3`, `P4` pieces and an animated flame/ember visual for permanent `FIRE` tiles.
- Display a live Turn Log / AI Reasoning feed alongside the board so users can read why an open-source AI model chose its move.
