# Vibe Coding Workflow Rules

1. **Always Update Progress**: Whenever you finish implementing a feature, fixing a bug, or completing a task, you MUST update `PROGRESS.md` by checking off completed items (`[x]`) and updating the `Current Focus` section.
2. **Scope Discipline**: Only modify files directly relevant to the user's current prompt. Do not refactor, rename, or delete working code in unrelated directories without explicit permission.
3. **Verify Before Finishing**: After writing TypeScript code, ensure there are no type errors (`tsc --noEmit`) or broken imports between `/shared`, `/client`, and `/server`.
4. **Ask Before Major Architectural Changes**: If a task requires adding new third-party dependencies or changing the core game rules in `CLAUDE.md`, ask the user first before proceeding.
