# Step 7: post_simplify_test > diagnosis

- Type: agent
- Objective: Analyze test failures and return structured diagnosis.

## Prompt

<!-- Workflow: execute, Namespace: ai, Step: diagnosis -->

# Test Diagnosis Agent

<derive from repository or prior step: review_mode>

## Mission

Run tests for **ai** (version: **<derive from repository or prior step: package_version>**) and diagnose any failures. Return a structured diagnosis that identifies:

<derive from repository or prior step: version_note>
1. Whether tests pass or fail
2. The primary failure mode
3. Which skills and files the fixer agent should use

---

## Test Command

Run this command to execute tests:

```bash
<derive from repository or prior step: test_command>
```

Output will be auto-saved to `<derive from repository or prior step: attempt_dir>/test-output-N.log` (auto-incremented)

---

## Analyzing Test Output

### Parse Test Results

Extract pass/fail/skip counts from output and identify the primary failure pattern.

### Debug Pattern Guide (dd-trace-js)

Test output for dd-trace-js plugins comes from **mocha**. The toolkit runs
`PLUGINS=<name> npm run test:plugins:ci` (the same command CI uses). Read the
mocha summary + stack traces; the patterns below cover the common failure
shapes.

#### Reading the test output

| What you see | What it usually means |
|---|---|
| `N passing` with `0 failing` | Suite green; if you reached this prompt the run never failed |
| `M failing` followed by stack traces | Real assertion or runtime failures; read each trace top-to-bottom |
| Tests time out (`Error: Timeout of … ms exceeded`) | The integration registered but spans aren't reaching the in-process agent — most often a missing/mistyped channel name, an `esmFirst` mismatch, or `OTEL_TRACES_EXPORTER=otlp` leaking in from the shell |
| `expected X to equal Y` on `tags`/`meta`/`metrics` | Plugin produces a span but the wrong shape — extractor bug |
| `EADDRINUSE`, `ECONNREFUSED` to a port | Per-plugin service (mysql, kafka, etc.) didn't come up; `yarn services` should have provisioned it via `test:plugins:ci` |
| `Cannot find module 'datadog-plugin-…'` | `PLUGINS=` value doesn't match a `packages/datadog-plugin-<name>/` directory — name normalization issue |
| No tests run, just a help banner | `PLUGINS=` is empty or the integration name doesn't resolve to a known plugin |

#### Pass/fail counts

- The mocha summary line at the end (`X passing (Yms)` / `Z failing`) is the
  authoritative test result, not the per-test "✓"/"✗" prefixes which can be
  truncated in piped output.
- Pending tests are counted separately (`W pending`); they don't fail the
  suite.


---

## Failure Modes

### Base Failure Modes (All Languages)

#### `tags`
**Description:** Wrong/missing tags on spans

**When to use:** Spans are created but tests fail due to missing or incorrect tag values.

**Symptoms:**
- Test assertions fail on tag/meta/metrics values (e.g. `expected X to equal Y` on a tag)
- Tests time out waiting for the right tag value to arrive
- Test agent / FakeAgent receives spans but with the wrong shape

#### `spans_not_created`
**Description:** Spans not being created at all

**When to use:** Tests run but no spans reach the test agent despite instrumentation being configured.

**Symptoms:**
- Test agent / FakeAgent receives no spans for the operation under test
- Tests time out waiting for spans that never arrive
- Assertions on the spans list see it empty

#### `spans_not_finished`
**Description:** Spans created but not finishing properly

**When to use:** Spans reach the test agent but never close (no end time / duration).

**Symptoms:**
- Spans visible in the test agent but missing expected end time / duration
- Tests hang waiting for a completed-span assertion
- Trace fragments without a closing event

#### `startup_failure`
**Description:** Test environment/setup failure

**When to use:** Tests fail before any instrumentation runs.

**Symptoms:**
- Connection errors (ECONNREFUSED, etc.)
- Missing Docker services
- Module not found errors
- Tests fail immediately with setup errors

#### `unknown`
**Description:** Unknown or unclassified failure

**When to use:** The failure doesn't match other modes.

**Symptoms:**
- Failure doesn't match known patterns

### Node.js Specific Failure Modes

#### `channels`
**Description:** Diagnostic channel publish/subscribe mismatch

**When to use:** Plugin is loaded by the tracer but no spans are produced — the instrumentation's `dc.publish` is firing without a subscriber, or the subscriber is wired to a name nothing publishes.

**Symptoms:**
- Tests time out waiting for spans that never arrive
- `DATADOG TRACER INTEGRATIONS LOADED` lists the plugin, but `agent` (FakeAgent) receives no payloads
- Plugin not receiving instrumentation events despite the integration loading

#### `errors`
**Description:** Error test cases failing

**When to use:** Error tags (error.message, error.type, error.stack) not captured on spans.

**Symptoms:**
- Error test cases timeout
- error: 1 tag missing from span
- Error thrown but not captured on span

#### `plugin_code`
**Description:** Plugin code errors

**When to use:** Syntax errors, logic bugs, or runtime exceptions in plugin files.

**Symptoms:**
- JavaScript syntax errors
- Runtime exceptions in plugin code
- Undefined variable or method errors

#### `orchestrion_instrumentation_config`
**Description:** Orchestrion JSON config issues

**When to use:** Instrumentation config has wrong paths, names, or settings.

**Symptoms:**
- Wrong file path in orchestrion JSON
- Class/method name mismatch
- Wrong operator (tracePromise vs traceCallback)

#### `wrapping`
**Description:** Shimmer wrapping failures

**When to use:** Legacy shimmer.wrap is wrapping the wrong method or signature doesn't match. Wrong type of tracing pattern applied.

**Symptoms:**
- Method wrapped but not called
- Arguments in wrong positions
- Callback not being intercepted
- async tracing being used instead of synchronous tracing

#### `hooking`
**Description:** Instrumentation hook failures. Or lack of instrumentation hooks firing.

**When to use:** Hook point is wrong - instrumenting the wrong lifecycle moment. No hooks or subscriber channel events firing.

**Symptoms:**
- Wrong module name being targeted for tests (tests target package. hooks target package/subpackage)

---

## Files to Check

Common files involved in test failures:

<derive from repository or prior step: files_to_check>

---

## Guidelines

1. **Run tests first** - Don't guess, analyze actual output
2. **Be specific** - Identify the exact failure mode
3. **Recommend skills** - Choose skills that will help fix this specific issue, common + specific failure mode skills
4. **List files** - Tell the fixer which files to examine
5. **Summarize output** - Include key error lines in test_output_summary


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  success: boolean,  // True if all tests pass
  integration_complete?: boolean,  // True ONLY if tests pass AND coverage is comprehensive. Set to False if there are missing_test_cases or incomplete coverage, even if tests pass.
  failure_mode?: string | null,
  suggestions?: string[],
  files_to_check?: string[],
  test_output_summary?: string | null,
  passing?: number,
  failing?: number,
  skipped?: number,
  missing_test_cases?: ({
      name: string,  // Short name for the test case (e.g., 'tool_calling', 'multi_turn')
      description: string,  // What this test should verify
      priority?: string,  // Priority: high, medium, low
  })[],  // Test cases that should be added for better coverage
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
