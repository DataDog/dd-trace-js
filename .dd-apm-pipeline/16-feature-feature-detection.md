# Step 16: feature > feature_detection

- Type: agent
- Objective: Check each feature type in parallel to see if it applies.

## Prompt

<!-- Workflow: create, Namespace: genkit, Step: feature_detection -->

# Single Feature Detection: <derive from repository or prior step: feature_id>

You are checking if the **<derive from repository or prior step: feature_id>** feature should be implemented for this integration.

## Feature Guide

Read the full feature guide at: `<derive from repository or prior step: feature_guide_file>`

This file describes what the feature is, when it applies, and implementation details.

## Integration to Analyze

**Integration**: genkit

**Analysis File**: `<derive from repository or prior step: analysis_file>`

Read this file to understand:
- The library category (database, messaging, HTTP, etc.)
- Instrumented methods and their span kinds (client, producer, consumer)
- Operations being traced
- Tags being captured

## Your Task

1. Read the analysis file at `<derive from repository or prior step: analysis_file>`
2. Determine if **<derive from repository or prior step: feature_id>** applies to this integration
3. Output your decision with reasoning

## Decision Guidelines

- **dsm** (Data Streams Monitoring): Applies to messaging/queue systems with producer AND consumer operations
- **context_propagation**: Applies to messaging systems, HTTP servers/web frameworks, and HTTP clients that need distributed trace context
- **dbm** (Database Monitoring): Applies to database clients that execute SQL queries
- **peer_service**: Applies to ANY client/producer making outbound calls (databases, messaging, HTTP, cache)

## Output

Your output must conform to the schema appended below.

Be accurate: only mark `applicable: true` if this feature genuinely applies to this library type.


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  feature_id: string,  // Feature ID that was checked
  applicable: boolean,  // Whether the feature should be implemented
  reasoning?: string,  // Why the feature is/isn't applicable
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **15 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~7 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
