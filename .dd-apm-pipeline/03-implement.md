# Step 3: implement

- Type: agent
- Objective: Apply the plan's diff to the working tree.

## Prompt

<!-- Workflow: execute, Namespace: ai, Step: implement -->

# Implementation Agent

You have an approved implementation plan. Your job is to apply it to the
working tree — read the in-scope files, write the necessary edits, then
return. Tests run in a **separate downstream step** (Python-driven), not
inside your context.

## Task Specification

<derive from repository or prior step: spec_body>

## Problem Statement

<derive from repository or prior step: problem_statement>

## Prior Decisions

<derive from repository or prior step: prior_decision_context>

## Root Cause

<derive from repository or prior step: root_cause>

## Approved Plan

<derive from repository or prior step: approved_plan>

## Task Breakdown

<derive from repository or prior step: plan_tasks>

## Files in Scope

<derive from repository or prior step: files_in_scope>

If a task you're about to apply doesn't tie back to a finding in the
Root Cause section above, stop and surface that — you're being asked to
implement scope creep that the plan reviewer would have caught if they'd
spotted it. Apply only work whose justification you can trace upward.

## What to do

1. Read each in-scope file you actually need.
2. Apply edits per the plan and task breakdown. Use the `Edit` and
   `Write` tools directly — keep changes minimal and targeted.
3. Stop when every task in the breakdown has been applied. Return
   `ImplementResult` with `files_modified`, `applied_tasks`, and a
   short `summary`.

## When you cannot proceed — halt instead of guessing

If a plan item is genuinely impossible to apply — the file it names
doesn't exist, the plan contradicts what the code actually does, the
instruction is ambiguous and you can't reasonably disambiguate, or
you'd need context the plan didn't provide — **do NOT silently skip
it and continue with the others.** Populate the `halt` field in your
`ImplementResult` with a structured halt object that names the blocker.

Use this only for genuine blockers. "I did 5 of 6 and the 6th was
optional" is partial work — that goes in `applied_tasks` with a short
note in `summary`. "The plan says edit `packages/foo/index.js` but no
such file exists in the repo" is a halt.

Example halt:

```json
{
  "files_modified": [],
  "applied_tasks": [],
  "summary": "Halted before applying any changes — see halt field.",
  "halt": {
    "step": "implement",
    "reason": "file_not_found",
    "detail": "Plan references packages/foo/index.js but no such file exists. Closest match: packages/datadog-plugin-foo/src/index.js.",
    "needs": "Planner should verify file paths against the actual repo structure before listing them in files_in_scope.",
    "suggestion": "Re-run plan with corrected scope; the kafkajs plugin lives under packages/datadog-plugin-kafkajs.",
    "consumable_by": ["plan"]
  }
}
```

Halt `reason` should be one of these machine-readable categories (pick the most specific):

- `file_not_found` — plan references a path that doesn't exist
- `plan_contradicts_code` — plan asks for a change incompatible with current code (method already exists, signature differs, etc.)
- `ambiguous_instruction` — plan task is unclear and reasonable interpretation isn't possible
- `missing_context` — you'd need information the plan didn't provide (a version, a config, a fixture)
- `dependency_missing` — a required dependency isn't installed or available
- `scope_unreachable` — files_in_scope can be read but the change the plan asks for is not possible there

The workflow will halt at this step, persist the halt to
`feedback.jsonl`, and surface it to the engineer (or to auto-recovery
when that lands). The consuming step you name in `consumable_by`
(usually `plan`) re-runs with the halt's `detail` and `needs` as
guidance — no human translation required.

## Hard Rules

You **must NOT**:

- **Run the test command** — whatever the spec or repo adapter calls it.
  The next step (a separate Python-orchestrated workflow) runs tests,
  groups failures by root cause, and applies fixes in tight focused agent
  passes. Running tests yourself burns wall-clock budget on `sleep`-and-poll
  loops, fills the SDK transport buffer with streamed test output, and
  duplicates the work of the dedicated test stage.
- **Sleep, poll, or background long-running tasks.** If you find
  yourself reaching for `sleep`, you're in the wrong step.
- **Spawn subagents whose job is to run tests or diagnose failures.**
  Diagnosis lives in `DiagnosisStage`; fixing failures lives in
  `FixerStage`. Both run after you return.

You **may**:

- Spawn read-only subagents for parallel exploration of large code
  surfaces, when the planner left an area ambiguous and you'd otherwise
  have to read 20+ files yourself to disambiguate.
- Run static checks the repo adapter exposes (e.g. linters), as long as
  they don't run the test suite.

## Repo-Specific Guidance

## dd-trace-js Implementation Guidance

### Repo Conventions
When applying the plan or writing prompts for read-only subagents:
- Package manager: **yarn for installs, npm for scripts**.
- **No `async/await` in production code** — use callbacks. (Tests can use async.)
- For plugin work, point at an existing plugin matching the target's hooking style:
  - `packages/datadog-plugin-langchain/` or `packages/datadog-plugin-bullmq/` for Orchestrion-based plugins
  - `packages/datadog-plugin-mongodb/` for shimmer-based ones
- For instrumentation work, reference the general instrumentations directory at `packages/datadog-instrumentations/` and pick a neighbor that matches the integration's class.
- **Prefer the Orchestrion JSON-rewriter API over `shimmer` for new work.** When an Orchestrion-based integration exists for a similar module, use it as the reference; fall back to `shimmer` only when the target module has no Orchestrion path yet.

### PR Metadata Fixes (used by `dd-apm pr`, not the implement agent)
- **PR title/name lint** (`pr_name_lint`, `pr-name-lint`): Fix via `gh pr edit --title "chore(<scope>): <description>"` using conventional commit format. Use the integration name as scope.
- **Missing changelog/release note**: Apply the `changelog/no-changelog` label if the change has no user-facing impact (`gh pr edit --add-label changelog/no-changelog`); otherwise add a release-note section per the PR description template.
- **Missing labels**: Add via `gh pr edit --add-label "<label>"`.



## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  files_modified?: string[],  // File paths the agent created or edited, repo-relative.
  applied_tasks?: string[],  // Short task names from the plan breakdown that were applied (e.g. ['Update plugin hooks', 'Add ESM handling']). Empty list means nothing was applied — the host workflow may treat that as failure depending on its review policy.
  summary?: string,  // Brief summary of the change (under 500 words). Do NOT include full code, diffs, or test output — the diff lives in the working tree and is read by the simplify step directly.
  halt?: {
      step: string,  // Which step is halting (e.g. 'implement', 'fixer', 'diagnose').
      reason: string,  // Machine-readable category. Pick the most specific that fits — e.g. 'file_not_found', 'plan_contradicts_code', 'ambiguous_instruction', 'missing_context', 'dependency_missing', 'no_work_produced'.
      detail: string,  // Concrete description of what blocked the step. Quote file paths, method names, and any specifics from the plan that don't match the code.
      needs: string,  // What the consuming step needs to know to address this on rerun. Should be readable as planner-input — e.g. 'Planner should verify file paths against actual file structure before listing them in files_in_scope.'
      suggestion?: string | null,  // Optional concrete recommendation for the rerun (e.g. 'Drop task 3, it duplicates task 1').
      consumable_by?: string[],  // Step name(s) that should re-run with this halt as feedback. For implement halts this is usually ['plan']. For fixer halts it might be ['fixer'] (retry) or ['plan'] (escalate). Empty list means the halt is informational only — the engineer decides where to rerun.
      artifact_refs?: string[],  // Optional paths or ctx keys that hold supporting context (a failing test, a diff, an error log) the consuming step should read.
  } | null,  // Populate ONLY when the agent cannot proceed — plan references a missing file, plan contradicts the code, instruction is ambiguous, etc. The workflow halts and surfaces this artifact so the engineer (or a future auto-recovery layer) can rerun the consuming step with this halt as feedback. Do NOT use this for 'I did most of it but skipped one' — partial work belongs in applied_tasks with a clear summary.
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
