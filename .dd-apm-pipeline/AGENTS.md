# Agent Execution Contract

Execute the `execute` workflow for `ai` in `dd_trace_js` using the current
coding-agent session. Do not launch `dd-apm` as a nested agent runner.

## Task

Fix DataDog/dd-trace-js#9276. The Vercel AI LLMObs plugin retains every tool
definition in `#availableTools` and every tool-call mapping in
`#toolCallIdsToName` for process lifetime. Implement the smallest maintainable
fix that preserves tool-name resolution while releasing per-request objects and
completed tool-call mappings. Keep production changes tightly scoped.

1. Read `PIPELINE.md` for the ordered stage list.
2. Read only the current numbered stage file; load its references on demand.
3. Complete stages in order. Use focused subagents when the harness supports them.
4. After each stage, record concrete evidence in `PROGRESS.md` before continuing.
5. After compaction or handoff, resume from `PROGRESS.md` and the first incomplete stage.
6. Split long-running shell work into commands that fit the harness execution limit.
7. Do not open a PR with failed validation, unreviewed changes, or unresolved blockers.
8. Do not include this bootstrap pipeline directory in the eventual production PR.
9. Final gates apply to one source state. Any code change during gating invalidates all of them.

Repository instructions and the user's latest request remain authoritative.
