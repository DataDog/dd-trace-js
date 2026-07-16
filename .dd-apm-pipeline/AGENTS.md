# Agent Execution Contract

Execute the `execute` workflow for `undici` in `dd_trace_js`. This directory is a
portable control bundle; do not launch `dd-apm` as a nested agent runner.

1. Read `TASK.md`, `PIPELINE.md`, then only the current numbered stage and its references.
2. Act as orchestrator. The main agent coordinates and integrates; focused subagents perform
   the substantial analysis, implementation, testing, and review work. Inspect their work before advancing.
3. Complete stages in order and record artifact-backed evidence in `PROGRESS.md`.
4. Treat conditional stages as branches, not checklist work. Skip them without invoking an
   agent when their condition is false. Never exceed two attempts for one repair branch.
5. Store small receipts under `evidence/` inside this control bundle; keep raw command output
   and trace payloads in its gitignored `raw/` directories. Do not create another evidence tree
   elsewhere in the repository. Never feed whole raw artifacts into another agent.
6. After compaction or handoff, re-read this file and resume at the first incomplete stage.
7. Split shell work to fit harness execution limits.
8. Do not open a PR with failed validation, unreviewed changes, unresolved blockers, control
   bundle changes, or evidence artifacts in the product diff.
9. Treat this directory as control input, not product code; do not modify or add it to an
   implementation commit unless the user explicitly requests that.
10. Final gates are verification-only and must all pass against one source state. A failure
    invalidates every final-gate receipt; return to the relevant repair branch, then restart
    final verification from build.

Repository instructions and the user's latest request remain authoritative.
