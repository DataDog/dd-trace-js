# Step 11: context_mapping

- Type: agent
- Objective: Map runtime-captured context to Datadog semantic span tags for each instrumentation target.

## Existing Workflow Guidance

Agent step (fast ~1-3 min — runs haiku in parallel batches of 10).
Depends heavily on generate_app quality: if the sample app didn't exercise a target
method, there is no runtime context to map and this step produces minimal output for
that target. The compiler will still produce code, but span tags may be less rich.

Language considerations:
- JS/Python: primary source of span tag knowledge — runtime context reveals what data
  is actually available (e.g. which arguments contain topic name, partition, offset).
- Java: type signatures already expose this; context_mapping adds less value.
  Skip with: --skip generate_app validate_app context_mapping

Output artifact: context-mappings.json (consumed by compile step)

## Prompt

<!-- Workflow: create, Namespace: genkit, Step: context_mapping -->

# Context-to-Tag Mapping Task

You are mapping semantic APM tags to runtime context paths for instrumentation.

## General Details

- **Mappings are for the node language and data access should be compatible for that langauge.**

## Operation Details

- **Method**: <derive from repository or prior step: method>
- **Operation**: <derive from repository or prior step: operation>
- **SpanKind**: <derive from repository or prior step: span_kind>
- **Instrumentation Index**: <derive from repository or prior step: instrumentation_index>

## Required Tags (MUST map ALL of these)

<derive from repository or prior step: required_tags>

## Optional Tags (map ONLY if data is available in context)

<derive from repository or prior step: optional_tags>

## Available Runtime Context

Full runtime context captured during execution is saved at: `<derive from repository or prior step: context_snapshot_file>`

Read this file to see all accessible data. You can map to any properties found there using paths like:
- `this.propertyName` - Access property on `this` object
- `args[0].field` - Access property on first argument
- `result.value` - Access property on return value

## Your Task

Map ONLY the tags listed above to context paths or literal values.

**CRITICAL RULES:**
1. **DO NOT add any custom tags** - Only map the tags explicitly listed above
2. **DO NOT create library-specific tags** (e.g., no bullmq.*, redis.*, kafka.*, etc.)
3. Map ALL required tags - they are mandatory for semantic conventions compliance
4. Map optional tags ONLY if the data exists in the runtime context
5. Use `null` for tags that cannot be mapped from available context
6. Use `'component': 'library name'` for the component tag

## Context Path Syntax

- `this.propertyName` - Access property on `this` object
- `args[0].propertyName` - Access property on first argument
- `returnValue.id` - Access property on return value (if available)
- `'literal'` - Use a literal string value (e.g., `'bullmq'`, `'produce'`)

## Mapping Examples

- messaging.system = `'bullmq'` (literal library name)
- messaging.destination.name = `this.name` (queue name from instance)
- messaging.operation = `'<derive from repository or prior step: operation>'` (literal operation name)
- span.kind = `'<derive from repository or prior step: span_kind>'` (literal span_kind: producer/consumer)
- messaging.message.id = `args[0].id` (message ID from argument)
- resource.name = `args[0].name` (job/message name)

## Tags Section Guidance

The `tags` dict should include tags that are CRITICAL for this specific operation.
Each tag should have a value that is one of:

- **Literal constant**: `"'producer'"` - A hardcoded string value (wrapped in single quotes)
- **Context path**: `"this.name"` - Extract from runtime context (same as mappings)
- **Type matcher - String**: `"__EXPECT_STRING_MATCHING__"` - Required tag, expect any string value
- **Type matcher - Number**: `"__EXPECT_NUMBER_MATCHING__"` - Required tag, expect any numeric value
- **Type matcher - Any**: `"__EXPECT_VALUE_MATCHING__"` - Required tag, expect any value
- **null**: Tag is not applicable or truly optional for this operation

## Output

Your output must conform to the schema appended below. Provide your mappings as structured JSON output.


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  instrumentation_index: number,
  method: string,
  operation: string,
  mappings?: Record<string, string | null>,
  tags?: Record<string, string | null>,
  error?: string | null,
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **20 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~10 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
