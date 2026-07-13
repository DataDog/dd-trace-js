# Step 21: llm_obs_test > llm_obs_diagnosis

- Type: agent
- Objective: Diagnose LLM obs test failures.
- Relevant skills: llmobs-testing

## Prompt

<!-- Workflow: llmobs, Namespace: genkit, Step: llm_obs_diagnosis -->

# LLM Observability Test Diagnosis

## Skills Available

**Optional but helpful:**
```
/skill llmobs-testing
```

Use the skill if you need to:
- Understand test structure and assertion patterns
- Review failure mode classifications
- Check category-specific test strategies (LlmObsCategory enum)
- Learn about assertion helpers (MOCK_STRING, MOCK_NOT_NULLISH, etc.)

---

## Your Task

**⚠️ CRITICAL: DIAGNOSIS ONLY - ABSOLUTELY NO FIXING ⚠️**

You are a DIAGNOSIS agent, NOT a fixer agent. Your ONLY job is:

1. **Run the test command ONCE** (exactly as provided below)
2. **Read the output**
3. **Return structured diagnosis** using the output format specified
4. **STOP - Do NOT:**
   - Edit any files
   - Create symlinks
   - Fix version wrappers
   - Investigate agent ports
   - Run tests multiple times

Run LLM observability tests for **genkit** and diagnose any failures.

## Context

**Integration:** genkit
**Test File:** `<derive from repository or prior step: test_file>`
**Iteration:** <derive from repository or prior step: iteration>
**Attempt Directory:** `<derive from repository or prior step: attempt_dir>`

## Previous Attempts

Prior step outputs are available in the workflow's `.analysis/` directory — check the `output.json` files in preceding step directories to understand what was built and what has already been tried.

---

## ⚠️ IMPORTANT: Tracing Pre-Check Completed ⚠️

**The workflow has already verified that tracing instrumentation works for genkit:**
- ✅ Tracing plugin exists
- ✅ Tracing integration tests PASS
- ✅ Spans are being generated correctly

**This means:**
- The tracing layer is working correctly and creating spans
- If LLMObs tests fail, the problem is in the LLMObs plugin code, NOT tracing instrumentation
- Focus your diagnosis on LLMObs plugin issues (channel subscription, tag extraction, message formatting)
- DO NOT investigate orchestrion config or tracing instrumentation files

**Files you should focus on:**
- ✅ LLMObs plugin code (`<derive from repository or prior step: llmobs_plugin_path>`)
- ✅ LLMObs test files (`<derive from repository or prior step: test_file>`)

---

## Instructions

### 1. Run the Tests

Execute the test command and capture full output:

```bash
<derive from repository or prior step: test_command>
```

The output will be saved to `<derive from repository or prior step: attempt_dir>/test-output.log`.

### 2. Analyze Test Results

Count the test results:
- **Passing:** Number of tests with ✓ or "passing"
- **Failing:** Number of tests with ✗ or "failing"
- **Skipped:** Number of tests marked as skipped

**Extract counts from test output patterns:**
- Mocha: "X passing", "Y failing"
- Jest: "X passed, Y failed"
- Generic: Count ✓ and ✗ symbols

### 3. Classify Failure Mode

**The tracing pre-check verified that tracing instrumentation works.**

If LLMObs tests fail, the problem is in the LLMObs plugin code, NOT tracing instrumentation.

**Use the llmobs-testing skill to identify the primary failure mode:**

- `span_events_missing` - LLMObs plugin not loading or not subscribing to channels correctly
- `tag_mismatch` - Extraction logic not handling data structure correctly
- `message_format_error` - Message extraction returning wrong format
- `token_count_error` - Token metrics not extracted or in wrong location
- `cassette_issue` - VCR not running or cassette missing (LlmObsCategory.LLM_CLIENT/MULTI_PROVIDER only)
- `plugin_not_loaded` - Plugin not in CompositePlugin or wrong ordering
- `test_utility_bug` - Test utility function has a bug (shared test infrastructure)
- `runtime_error` - Code execution errors (TypeError, ReferenceError, etc.) in LLMObs plugin

**Refer to the skill for:**
- Error patterns for each failure mode
- Likely causes in LLMObs plugin code
- What to check in the LLMObs plugin

**Common LLMObs plugin issues:**

1. **Channel subscription issues** - Plugin not subscribing to correct tracing channels
   - Check channel names match tracing plugin prefixes
   - Check subscription is registered in plugin constructor

2. **Tag extraction issues** - Plugin extracting data from wrong locations
   - Check `setLLMObsTags()` method
   - Verify input/result structure matches what tracing plugin provides

3. **Message format issues** - Messages not in the expected format
   - Check message extraction helper methods
   - Ensure returning messages in the correct structure

4. **Plugin loading issues** - Plugin not registered in CompositePlugin
   - Check LLMObs plugin imported and added to plugins array BEFORE tracing plugins
   - Verify plugin class name and export

### 4. Identify Specific Issues

For each failing test, extract:

**Span Event Issues:**
- Missing fields (e.g., "inputMessages undefined")
- Wrong types (e.g., "expected array, got string")
- Empty values when non-empty expected
- Wrong `LlmObsSpanKind` (e.g., expected `'llm'`, got `'workflow'`)

**Tag Mismatches:**
- Expected vs actual values
- Field paths (e.g., "metadata.temperature")
- Data type issues
- Message format issues (incorrect structure)

**Test Output Excerpt:**
Include the most relevant 20-30 lines showing the failure.

### 5. Provide Diagnosis

**Failure Details:**
Explain what's happening in 2-3 sentences.

**Root Cause:**
Identify the likely source of the problem (which file, which method).

**Suggested Fix:**
Based on llmobs-testing skill patterns, suggest how to fix the plugin code.

---

## Guidelines

- **Run tests first** - Execute the test command, capture output
- **Investigate root cause** - If the failure mode isn't obvious, read relevant files to understand why the test is failing. This reduces iterations in the fixer step.
- **No code changes** - You are READ-ONLY. Never edit, write, or create files.
- **No running tests multiple times** - One test run, then investigate with file reads

---

## ⚠️ FINAL REMINDER ⚠️

After running the test command ONCE:
1. Count passing/failing/skipped tests
2. Identify failure_mode from the error patterns
3. If the root cause isn't clear from the test output alone, read the relevant plugin files
4. Return a complete diagnosis with root cause identified — a better diagnosis means fewer fixer iterations

---

## Success Criteria

- Test counts are accurate
- Failure mode correctly classified using skill's failure mode definitions
- Specific issues identified (not vague)
- Root cause pinpointed to specific file/method
- Actionable fix suggestions provided based on skill patterns


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  integration_complete?: boolean,  // Whether the integration is complete and ready
  tests_passing?: boolean,  // Whether all tests are passing
  passing?: number,  // Number of passing tests
  failing?: number,  // Number of failing tests
  skipped?: number,  // Number of skipped tests
  failure_mode?: FailureMode,  // Primary failure mode detected
  failure_details?: string,  // Detailed failure analysis
  files_to_fix?: string[],  // Specific files that need to be modified to fix the issue (relative to repo root)
  span_event_issues?: string[],  // Specific span event problems (e.g., 'missing inputMessages')
  tag_mismatches?: string[],  // Tag value mismatches (e.g., 'modelName: expected X got Y')
  test_output?: string,  // Raw test output
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
