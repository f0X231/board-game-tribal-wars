---
name: ai-arena
description: Integration with free open-source LLM APIs (OpenRouter, Groq), prompt formatting, legal move selection, and AI-vs-AI spectator pacing in /server.
---

# Tribal Wars - AI Arena & Open Source LLM Integration

When building or debugging AI bots in `/server`, follow these patterns:

## 1. API Client Setup
- Use the standard `openai` Node.js SDK configured with custom `baseURL` endpoints:
  - **OpenRouter**: `https://openrouter.ai` (target `:free` models like `meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen-2.5-72b-instruct:free`, `google/gemma-2-9b-it:free`).
  - **Groq**: `https://groq.com` (target fast free-tier models like `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`).
- Store API keys strictly in `/server/.env` (`OPENROUTER_API_KEY`, `GROQ_API_KEY`).

## 2. Anti-Hallucination Move Selection (Critical)
- **Never** ask the LLM to output raw board coordinates directly.
- Always generate `const validActions = FireAmazonsEngine.getValidActions(state, aiPlayer)` first.
- Map `validActions` to numbered choices (e.g., `0: Move (0,0)->(0,3), Shoot (2,3)`).
- Prompt the LLM to analyze board control/mobility and respond strictly in JSON: `{"actionIndex": number, "reasoning": "short string"}`.
- **Fallback Safety**: If the LLM times out (>10s), returns invalid JSON, or picks an out-of-bounds index, automatically pick a valid fallback move so the match never crashes.

## 3. AI vs AI Spectator Mode
- When consecutive turns are controlled by AI models, inject an artificial delay (configurable `1000ms` to `2500ms`) before emitting the new `GameState` so human spectators can visually track the move and fire arrow.
