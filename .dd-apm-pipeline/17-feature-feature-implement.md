# Step 17: feature > feature_implement

- Type: agent
- Objective: Implement each detected feature sequentially.
- Relevant skills: apm-integrations, llmobs-integrations, datadog-semantics, observability-patterns

## Prompt

<!-- Workflow: create, Namespace: genkit, Step: feature_implement -->

# Task: Add <derive from repository or prior step: feature_id> feature to genkit

## Feature Implementation Guide

Read the full implementation guide at: `<derive from repository or prior step: feature_guide_file>`

## General Guidelines

Read general guidelines at: `<derive from repository or prior step: general_guidelines_file>`

## Instructions

1. **Analyze the integration**: Look in `<derive from repository or prior step: plugin_path>`
   - Check tests at `<derive from repository or prior step: test_file_path>`

2. **Write tests FIRST (TDD)**:
   - Add test cases for the new feature
   - Run tests to confirm they fail

3. **Implement the feature**:
   - Modify the plugin code
   - Follow patterns in implementation guide

4. **Run tests to verify**:
<derive from repository or prior step: test_instructions>

## Logging

All logs go to: `<derive from repository or prior step: logs_dir>/`

Save test output: `<cmd> 2>&1 | tee <derive from repository or prior step: logs_dir>/test-output-XX.log`

## Reference Integrations

<derive from repository or prior step: reference_integrations>

## CRITICAL RULES

**DELETING TESTS IS NEVER A VALID FIX.** If you delete, skip, or comment out tests, that is a FAILURE.
Tests exist to verify real functionality users need. Deleting error tests means errors won't be captured in production.

**YOU MUST ENSURE TESTS PASS BEFORE EXITING.**
- If you have not tried at least 15 test runs, you MUST NOT EXIT.
- Continue iterating until tests pass. You have 750 turns to fix the tests.
- We should NEVER exit with failing tests - failing tests will break our instrumentation.


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  feature_id: string,  // Feature that was implemented
  tests_passing: boolean,  // True if tests pass after implementation
  changes_made?: string[],
  explanation?: string | null,
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **300 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~150 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
