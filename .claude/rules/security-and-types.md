---
paths:
  - "client/**/*"
  - "server/**/*"
  - "shared/**/*"
---

# Security & Strict TypeScript Rules

1. **Zero Secrets in Client**: NEVER expose API keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`) or server secrets inside `/client` or prefix them with `NEXT_PUBLIC_`. All AI API calls must execute strictly inside `/server`.
2. **Strict TypeScript**: Never use `any` or `@ts-ignore` to bypass type checking. Always import shared data models (`GameState`, `MoveAction`, `BoardSize`, `PlayerId`) from `/shared`.
3. **Deterministic Game Logic**: Keep `Math.random()` isolated strictly to initial board setup (`createGame`). All move validations and turn transitions must be 100% deterministic.
