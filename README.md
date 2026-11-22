# 🔥 Tribal Wars — AI Arena & Strategy Board Game

**Tribal Wars** is a turn-based tactical grid strategy board game inspired by *Game of the Amazons* with an Aztec tribal theme. Players move like a Chess Queen, leave permanent fire trails on vacated squares, and shoot fire arrows to trap rival tribes—featuring an **AI Arena** powered by free open-source LLM models (Groq & OpenRouter).

---

## 📁 Project Structure

```text
tribal-wars/
├── client/          # Next.js (App Router) + Tailwind CSS frontend UI
├── server/          # Node.js + Express backend & AI Arena API connector
├── shared/          # Pure TypeScript game engine, rules, and unit tests
├── CLAUDE.md        # Architectural guidelines & game rules for AI assistants
└── PROGRESS.md      # Development roadmap and task tracker
```

---

## ⚙️ Prerequisites & Environment Setup

1. **Node.js** (v18 or higher recommended)
2. **Free API Keys** (Optional, built-in offline bots work without keys):
   - Get a free API key from [Groq Console](https://groq.com)
   - Get a free API key from [OpenRouter](https://openrouter.ai)

3. **Configure Server Environment:**
   Create a `.env` file inside the `/server` directory (`server/.env`):
   ```env
   PORT=4000
   GROQ_API_KEY=your_groq_api_key_here
   OPENROUTER_API_KEY=your_openrouter_api_key_here
   BOT_TIME_BUDGET_MS=3500   # thinking time per turn for the 7 research bots (100–5000)
   ```
   *(Note: Never commit `server/.env` to Git. It is already ignored by `.gitignore`.)*

---

## 🚀 Running the Application (Development)

To play the game and use the AI Arena, run both the **Server** and **Client** simultaneously in two separate terminal windows:

### Terminal 1: Start the Backend Server
```bash
cd server
npm install
npm run dev
```
*The server will start on `http://localhost:4000`.*

### Terminal 2: Start the Frontend Client
```bash
cd client
npm install
npm run dev
```
*Open your browser and go to **`http://localhost:3000`**.*

---

## 🔬 Research Algorithms (7 Papers)

Seven deep-search bots based on the computer-Amazons literature, adapted to Tribal Wars rules (fire at both the vacated square and the arrow square, snake-draft placement, 2–4 tribes). They run on the server in worker threads, think for `BOT_TIME_BUDGET_MS` (default 3.5 s) per turn using iterative deepening or MCTS, and never exceed a hard 5 s ceiling. Pick them in the Lobby under **Research Algorithms (7 Papers)**; their search stats (e.g. `[Depth 4 | 382,912 nodes | Score +12.4]`) appear in the Battle Log and in the match telemetry.

| Model id | Paper | Core idea |
|---|---|---|
| `research:anky-rel-territory` | Hensgens 2001 | Relative-territory evaluation (Queen BFS), selective top-K alpha-beta, single-agent endgame filling |
| `research:mg-peo-mcts` | Zhang et al. 2024 | MCTS with Move Groups (move → arrow layers), UCT C=√0.5, 2-pass shallow rollouts, phased Table-1 evaluation |
| `research:cgt-subgame` | Song & Müller 2012 | Board partition (simple / blocker territories, active areas), plodding bounds, AES safe moves, alpha-beta over active areas |
| `research:amazong-guard` | Lieberum 2005 | `t + m + g − s` evaluation: openness-weighted territory, per-totem enclosure α, n-guard, filling defects; aspiration alpha-beta |
| `research:tas-move-cat` | Higashiuchi & Grimbergen 2005 | 10-feature move categorization with progress-dependent ordering, alpha-beta + transposition table |
| `research:arrow-lsg` | Müller & Tegos 2002 | Layered forward pruning (top 50% by min-distance, then full evaluation), NegaScout, endgame defect/zugzwang terms |
| `research:tds-endgame` | Kloetzer, Iida & Bouzy 2009 | Subgame temperatures ((LeftStop − RightStop)/2), UCT in the hottest subgame, alpha-beta verification |

### Running a research tournament
```bash
cd server
npm run experiment -- --models research:arrow-lsg,research:mg-peo-mcts --games 10 --board 10 \
  --bot-budget-ms 3500 --jsonl results.jsonl --csv results.csv
```
Every match is also saved to `server/data/matches/` (served by `GET /api/matches` and `GET /api/matches/<id>/export?format=csv`). Options: `--board 6|10|12`, `--pieces N`, `--placement MANUAL|RANDOM`, `--seed N`, `--no-rotate`, `--tag name`. Mix in `offline:heuristic` or LLM ids to compare against other players.

---

## 🧪 Testing & Verification Commands

### 1. Test Core Game Engine (`/shared`)
Run unit tests and full 50-match headless simulations to verify movement, fire trails, Snake Draft placement, and elimination rules:
```bash
cd shared
npm install
npx tsx gameEngine.test.ts    # Run unit tests
npm run simulate              # Run 50 full random match simulations
npx tsc --noEmit              # Check TypeScript types
```

### 2. Verify Server & Client Builds
Check for TypeScript errors or production build issues before committing changes:
```bash
# Check Server (tests include all 7 research bots on 6x6/10x10/12x12, 2 and 4 tribes, and the 5 s ceiling)
cd server
npx tsc --noEmit
npm test
npm run build

# Check Client
cd client
npx tsc --noEmit
npm run lint
npm run build
```

---

## 📜 Quick Rules Summary

1. **Setup (Snake Draft):** 2–4 tribes take turns placing totems in snake order (`P1 → P2 → P3 → P3 → P2 → P1`). The player who places the **last totem** moves first!
2. **Turn Sequence (3 Steps):**
   - **Move:** Move 1 totem any number of unobstructed squares orthogonally or diagonally (like a Chess Queen).
   - **Fire Trail:** The exact square you just left immediately ignites into a **permanent Fire tile**.
   - **Shoot Fire Arrow:** From your new square, shoot a fire arrow in any Queen direction to create another **permanent Fire tile**.
3. **Win Condition:** Fire tiles never expire and block both movement and arrows. A tribe is eliminated when none of its totems can complete both a move and a shot. **Last tribe standing wins!**
