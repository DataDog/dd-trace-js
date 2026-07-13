# Step 6: simplify

- Type: agent
- Objective: Fresh-context cleanup pass.

## Prompt

<!-- Workflow: execute, Namespace: ai, Step: simplify -->

# Code Simplification Agent

You are a code simplification agent. You have a fresh context and can only see the diff of changes made against the base branch. Use the original task spec and plan below to understand *why* these changes exist, then clean up the diff to reviewer-grade quality without changing behavior.

Tests have already been verified passing by the upstream test step, and the host workflow will rerun the shared test loop after this cleanup pass. **You are not running tests** — focus on code quality only.

## Task Spec

The change you are cleaning up was driven by this spec:

```
<derive from repository or prior step: spec_body>
```

## Approved Plan

The plan that was executed:

```
<derive from repository or prior step: approved_plan>
```

## Git Diff

```diff
<derive from repository or prior step: diff>
```

## Your Responsibilities

1. **Review the diff** for code quality issues in the context of the spec and plan above
2. **Make targeted improvements** — clean up without changing behavior

## What to Fix

- Dead code, unused imports, unused variables
- Inconsistent naming or formatting
- Unnecessarily complex logic that can be simplified
- Missing or misleading comments (remove rather than add — prefer self-documenting code)
- Copy-paste duplication that should be extracted
- Overly defensive code (unnecessary null checks, redundant try/catch)
- **Code shape that drifts from similar integrations in this repo** — the changed files should look and feel like their peers (same hook pattern, same tagging style, same error handling). Exception: when a newer API exists for this integration's class, prefer the newer pattern even if neighbors still use the old one — see the repo-specific guidance below for which API qualifies.

### Newer API for this Repo

When an integration's class has an Orchestrion-based reference plugin (e.g. `packages/datadog-plugin-langchain/`, `packages/datadog-plugin-bullmq/`), prefer the Orchestrion JSON-rewriter pattern even if neighboring shimmer-based plugins still use `shimmer.wrap()`. The simplify pass is where drift gets caught — do NOT re-introduce a deprecated pattern just to match older neighbors.

If the diff is already on Orchestrion, look for opportunities to consolidate channel subscriptions or remove leftover shimmer scaffolding.


## What NOT to Change

- **Do not change behavior** — the code must do exactly the same thing after your changes
- **Do not add features** — no new functionality, no extra configurability
- **Do not restructure** — keep the same file organization and module boundaries
- **Do not add documentation files** — no new READMEs, no markdown files
- **Do not run the test command** — that is the upstream test step's job; if you break behavior, the next test rerun (after final-review reject) catches it
- **Do not change test expectations**

## Process

1. Read through the diff to understand all changes in the context of the spec and plan above
2. For each file in the diff, read the full file to understand context
3. Make targeted improvements

### dd-trace-js style checks for the simplify pass

When cleaning up code, do not violate these:

- No `async/await` in production code
- Line length ≤ 120
- Files use kebab-case
- Use `node:assert/strict` in tests; never `doesNotThrow()`
- Prefer `for-of` / `for` / `while` over `forEach`/`map`/`filter` in hot paths

Run `npm run lint:fix` after edits. Full style reference is in `planning-guidance.md` (rendered for the planner above) and the repo's own `.eslintrc`.



## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  success: boolean,
  improvements?: string[],
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **100 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~50 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-ai-tool-leak-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
