# Step 25: reviewer > review_cycle > batch_review

- Type: agent
- Objective: Run all checks in parallel.

## Prompt

<!-- Workflow: create, Namespace: genkit, Step: batch_review -->

# Code Review Check: <derive from repository or prior step: check_name>

You are running a focused code review check for **genkit**.

**Your job**: Find issues that a senior engineer would **block a PR** for. Skip style nits.

## Plugin Path
`<derive from repository or prior step: plugin_path>`

## Check Details

<derive from repository or prior step: check_content>

<derive from repository or prior step: custom_guidance>

<derive from repository or prior step: analysis_info>

---

## Instructions

1. **Read the check above carefully** - understand what to look for
2. **Search the files** specified in the check's "Files" section
3. **Flag only issues worth blocking a PR** - correctness bugs, spec gaps, meaningful quality problems
4. **Return structured todos** for each real issue found

### What to flag
- Correctness bugs (wrong behavior, broken async, missing error handling)
- Specification gaps (required functionality not implemented)
- Meaningful quality issues (code that will cause maintenance problems)

### What to skip
- Minor naming/style preferences
- Subjective formatting choices
- Trivial comment tweaks
- Issues that are technically imperfect but functionally correct

**Precision over recall** - fewer, higher-quality findings are better than a long list of nits. If you're unsure whether something is worth flagging, skip it.


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  check_id: string,  // Which check produced this
  todos?: ({
      id: string,  // Unique identifier
      check_id?: string,  // Which check produced this todo (set by aggregate)
      priority?: TodoPriority,
      description: string,  // What needs to be done
      file?: string | null,  // File path if applicable
      line?: number | null,  // Line number if applicable
      fixable?: boolean,  // Can be auto-fixed by agent
  })[],
  summary?: string,
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **100 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~50 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
