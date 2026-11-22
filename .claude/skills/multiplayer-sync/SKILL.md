---
name: multiplayer-sync
description: Real-time online multiplayer room management, Socket.IO event contracts, turn timers, and server-authoritative state synchronization for 2-4 players.
---

# Tribal Wars - Online Multiplayer & Socket.IO Guidelines

When working on real-time networking in `/server` and `/client`, enforce these rules:

## 1. Authoritative Server Architecture
- The server holds the single source of truth (`GameState`) in memory per room.
- Clients NEVER compute state transitions for online games; they only emit `submit_action` with `{ roomId, action }`.
- Server must validate every incoming action via `FireAmazonsEngine.applyAction()` and reject unauthorized or out-of-turn requests.

## 2. Room & Lobby Lifecycle
- Support room creation with custom `GameConfig` (`boardSize`, `playerCount`, `piecesPerPlayer`) and slot assignments (`HUMAN` vs `AI:<model_id>`).
- Handle player disconnections gracefully: if a human disconnects mid-game, either allow reconnection within 30s or convert their slot to a fallback AI bot so remaining players (in 3–4 player games) can finish the match.

## 3. Standard Socket Events
- `create_room` / `join_room` -> returns `{ roomId, roomState }`
- `start_game` -> broadcasts initial `game_state_updated`
- `submit_action` -> validates and broadcasts `game_state_updated` + `last_action_animation` (so clients can animate the move trail and arrow shot)
