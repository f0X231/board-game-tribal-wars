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
# Check Server
cd server
npx tsc --noEmit

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
