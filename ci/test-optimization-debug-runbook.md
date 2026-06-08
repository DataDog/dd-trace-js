# Test Optimization Debug Runbook for Coding Agents

This runbook is to diagnose Datadog Test Optimization setup problems in a JavaScript repository.
Use repository-specific judgment to adapt commands.

## Agent Execution Summary

- Step 0: clean prior artifacts.
- Wrapper path: choose one small test command from Step 2, then run
  `node ./node_modules/dd-trace/ci/test-optimization-debug.js --test-command "$(cat dd-test-optimization-test-command.txt)" --no-open`
  as described in the Preferred Wrapper section below.
- Step 1 is optional on the wrapper path because the wrapper runs static diagnosis and writes
  `dd-test-optimization-static.json`. Run Step 1 first when the wrapper is unavailable or when
  command selection needs static framework details.
- If the wrapper succeeds with `Reporting complete`, skip manual Steps 3-6 and continue to Step 7.
- Step 7: run the EFD check: first run -> known tests file -> add temporary test -> second EFD run -> validation.
- Step 7 cleanup: remove the temporary test and verify it is gone.
- Step 8: use the final report template and answer the four diagnostic questions with the question text inline.

The goal is to answer four questions:

1. Is `dd-trace` installed and statically configured in a supported way?
2. Does `dd-trace/ci/init` reach the test process through `NODE_OPTIONS`?
3. Does a small test subset send Test Optimization requests to a local fake intake?
4. If data is reported, does it include "all expected test event levels"?

Diagnostic question map:

- Is `dd-trace` installed and statically configured in a supported way? Step 1.
- Does `dd-trace/ci/init` reach the test process through `NODE_OPTIONS`? Steps 2 and 4.
- Does a small test subset send Test Optimization requests to a local fake intake? Steps 3, 4, and 5.
- If data is reported, does it include session, module, suite, and test events? Step 6.
- Step 8: synthesize all diagnostic answers.

"All expected test event levels" means:

- `test_session_end`
- `test_module_end`
- `test_suite_end`
- `test`

Do not use a real Datadog API key for this flow. Always route to the local fake intake.

## Preferred Wrapper

Use this wrapper when available. Adapt only the `--test-command` value. Use `--no-open` by default
for coding-agent runs; the HTML report URL and path are still printed and opening the file is not
part of the diagnosis.

Wrapper happy path:

1. Choose one small test command using the Step 2 priority table.
2. Run the wrapper with the selected command and `--no-open`; the wrapper binds `127.0.0.1`, so
   sandboxed environments may need loopback bind/connect approval.
3. If it reports `Reporting complete`, skip manual Steps 3-6.
4. Run Step 7 to validate EFD.
5. Run the Step 8 summary extractor and use the final response template.

Adapt:

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js --test-command "npm test -- path/to/test.spec.js" --no-open
```

Yarn example:

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js --test-command "yarn test path/to/test.spec.js" --no-open
```

After completing Step 2, use the selected-command file:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command "$(cat dd-test-optimization-test-command.txt)" \
  --no-open
```

Sandbox note: if wrapper startup fails with `listen EPERM 127.0.0.1`, retry the same wrapper
command with loopback bind/connect approval. This is a local environment permission failure, not a
Test Optimization reporting failure. After one loopback permission failure, run subsequent wrapper
or manual fake-intake commands with the same loopback approval.

The wrapper runs the static diagnosis, starts the fake intake in the same Node.js process, runs the
selected test command, stops the intake, writes all artifacts, renders the final report, and tries
to open the local HTML report. If the open attempt fails, continue; it does not affect the
diagnosis. The wrapper writes `dd-test-optimization-test-command.txt`; later steps read that file
instead of asking the agent to reconstruct the selected command.

If the wrapper succeeds and the primary stage is `Reporting complete`, skip manual Steps 3-6 and
continue to Step 7.

Wrapper success produces the same analysis and final-report artifacts that manual Steps 3-6
produce. Use these wrapper-generated root artifacts for Step 8:

- `dd-test-optimization-agent-report.txt`
- `dd-test-optimization-agent-report.json`
- `dd-test-optimization-final-report.txt`
- `dd-test-optimization-intake.json`
- `dd-test-optimization-report.html`

Analyzer JSON key paths used in this runbook:

- `primaryStage`
- `summary.requestCount`
- `summary.citestcycle.payloadCount`
- `summary.events.counts`
- `summary.events.missingLevels`
- `summary.decodeErrors`
- `summary.efd.settingsEnabled`
- `summary.efd.requested`
- `summary.efd.knownTestsReceived`
- `summary.efd.retriedNewTests`
- `summary.efd.retriedNewTestNames`

For the EFD check later in this runbook, use wrapper `--out-dir` values so the first and second
runs do not overwrite each other.

The wrapper binds a local fake intake on `127.0.0.1` and the test process connects back to it. In
sandboxed agent environments, the wrapper may require the same loopback bind/connect approval as
the manual intake path.

If the wrapper reports `Nothing` but the selected test clearly ran and `dd-trace/ci/init` output or
debug logs show that `NODE_OPTIONS` reached the test process, rerun the manual path in one shell
sequence with the intake alive through test execution, shutdown, and analysis before treating
`Nothing` as a tracer failure.

Use the manual fallback path below only when the wrapper is unavailable, when it fails before
producing artifacts, when it reports `Nothing` after a confirmed test run, or when the repository
needs framework-specific command handling.

## Tools

These files are published under the `dd-trace/ci` package directory:

- `diagnose.js`: static repository inspection.
- `test-optimization-debug.js`: wrapper for the end-to-end debug flow.
- `test-optimization-intake.js`: local fake intake and static self-contained HTML report.
- `test-optimization-analyze-intake.js`: fixed-rule analyzer for saved intake artifacts.
- `test-optimization-render-report.js`: final customer-facing report renderer.
- `test-optimization-intake-analysis.js`: shared decision-tree rules.

## Expected Output

- Static diagnosis can report `Missing Test Optimization initialization`; the live debug run injects
  `NODE_OPTIONS="-r dd-trace/ci/init"`.
- A successful basic reporting check has primary stage `Reporting complete`.
- Successful basic reporting includes session, module, suite, and test events.
- Harmless stdout from `dd-trace/ci/init` can be ignored. Do not ignore warnings about missing
  `DD_API_KEY` or disabled CI Visibility reporting.

## Command Labels

- `Verbatim`: run the command as written.
- `Adapt`: inspect the repository and replace the indicated value before running.

## Steps

### 0. Clean prior artifacts

Intentionally overwrite or remove any prior run artifacts:

Verbatim:

```bash
if [ -f dd-intake-log-path.txt ]; then
  INTAKE_LOG="$(cat dd-intake-log-path.txt)"
  rm -f "$INTAKE_LOG"
fi

rm -f \
  dd-intake-html-file-url.txt \
  dd-intake-html-path.txt \
  dd-intake-log-path.txt \
  dd-intake.pid \
  dd-intake-shutdown-url.txt \
  dd-intake-url.txt \
  dd-test-optimization-env.txt \
  dd-test-optimization-efd-command.txt \
  dd-test-optimization-efd-temp-test-file.txt \
  dd-test-optimization-known-tests.json \
  dd-test-optimization-agent-report.json \
  dd-test-optimization-final-report.txt \
  dd-test-optimization-static.json \
  dd-test-optimization-intake.json \
  dd-test-optimization-agent-report.txt \
  dd-test-optimization-test-command.txt \
  dd-test-optimization-test-exit-code.txt \
  dd-test-optimization-test-output.txt \
  dd-test-optimization-test-result.txt \
  dd-test-optimization-report.html

rm -rf \
  dd-test-optimization-basic \
  dd-test-optimization-efd
```

Reruns use stable artifact names by default. Remove stale intermediate artifacts before continuing.

### 1. Check static setup

From this repository root:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/diagnose.js --json --fail-on=never > dd-test-optimization-static.json
```

Print actionable static findings:

Verbatim:

```bash
node -e '
const fs = require("node:fs")
const d = JSON.parse(fs.readFileSync("dd-test-optimization-static.json", "utf8"))
for (const r of d.results || []) {
  if (r.status === "error" || r.status === "warning") {
    console.log([r.status, r.title, r.message, r.recommendation].filter(Boolean).join(" | "))
  }
}
'
```

Read the static diagnosis first. Pay special attention to framework support, framework version,
initialization, CI workflow, and git metadata findings.

The actionable static items are in `results[]`. Focus on entries where `status` is `error` or
`warning`.

If `Missing Test Optimization initialization` appears, continue. Step 4 injects
`NODE_OPTIONS="-r dd-trace/ci/init"` for the live intake check.

The static diagnosis does not prove the live debug command has an API key. The live run below must
set `DD_API_KEY=debug`; without an API key, `dd-trace/ci/init` can warn and skip reporting while
the selected tests still pass.

### 2. Choose a test command (wrapper path entry point)

Inspect `package.json`, framework config files, and the static diagnosis output.
Use the actionable static findings printed in Step 1 when Step 1 was run. On the wrapper path, the
wrapper produces the root `dd-test-optimization-static.json` after the selected command is chosen.
This is the only step required before running the Preferred Wrapper.

Run discovery commands:

Verbatim:

```bash
cat package.json
git status --short

find . \
  \( -path ./node_modules -o -path ./.git -o -path ./vendor \) -prune -o \
  \( -name "*.test.js" -o -name "*.spec.js" -o -name "*.test.ts" -o -name "*.spec.ts" \
     -o -name "*.cy.js" -o -name "*.cy.ts" \) \
  -print | head -20

find . \
  \( -path ./node_modules -o -path ./.git -o -path ./vendor \) -prune -o \
  \( -name "jest.config.*" -o -name ".mocharc.*" -o -name "cypress.config.*" \
     -o -name "playwright.config.*" -o -name "vitest.config.*" -o -name "cucumber.*" \) \
  -print | head -20
```

Choose the smallest command that genuinely runs tests.

Command selection priority:

| Priority | Repository shape | Selected command |
| --- | --- | --- |
| 1 | Yarn project where `scripts.test` accepts file arguments | `yarn test path/to/test-file` |
| 2 | npm project where `scripts.test` accepts file arguments | `npm test -- path/to/test-file` |
| 3 | `scripts.test` cannot accept direct file arguments | `./node_modules/.bin/runner-binary path/to/test-file` |
| 4 | `scripts.test` is absent | `./node_modules/.bin/runner-binary path/to/test-file` |
| 5 | Cypress project | repository Cypress command with one `--spec path/to/spec` equivalent |
| 6 | Playwright project | repository Playwright command with one test file or grep filter |

Selection guardrails:

- Prefer one or two existing test files.
- Prefer test files that are not listed in `git status --short`; avoid user-modified files when a
  clean equivalent exists.
- Preserve the repository's normal runner command when possible.
- Avoid full suites, watch mode, update snapshots, browser UI mode, or destructive scripts.
- If `scripts.test` already contains runner flags, verify the file argument reaches the runner as intended.
- Never write a bare runner binary command such as `mocha test/sum.spec.js`.

Set `SELECTED_TEST_COMMAND` to the selected command, then write it:

Adapt:

```bash
SELECTED_TEST_COMMAND='FILL_IN' # replace FILL_IN before running, for example: npm test -- test/sum.spec.js
# Yarn example: SELECTED_TEST_COMMAND='yarn test test/sum.spec.js'
# Direct binary example: SELECTED_TEST_COMMAND='./node_modules/.bin/jest test/foo.test.js'
if [ "$SELECTED_TEST_COMMAND" = 'FILL_IN' ] || [ -z "$SELECTED_TEST_COMMAND" ]; then
  echo "Replace FILL_IN with the selected test command before continuing."
  exit 1
fi
printf 'Selected test command: %s\n' "$SELECTED_TEST_COMMAND"
printf '%s\n' "$SELECTED_TEST_COMMAND" > dd-test-optimization-test-command.txt
printf '%s\n' 'unknown' > dd-test-optimization-test-result.txt
```

## Manual Fallback Path

Run manual Steps 3-6 only when the wrapper path is unavailable or inconclusive. If the wrapper
succeeded with `Reporting complete`, skip to Step 7.

### 3. Start the fake intake and report artifact

Start the fake intake as a background process and redirect its stdout to a temporary log. The
startup log contains the random port and the shutdown token needed by later steps.

Persist cross-step state files in the repository root.

Launch:

Verbatim:

```bash
set -e

INTAKE_LOG="$(mktemp "${TMPDIR:-/tmp}/dd-test-optimization-intake.XXXXXX.log")"
echo "$INTAKE_LOG" > dd-intake-log-path.txt

node ./node_modules/dd-trace/ci/test-optimization-intake.js \
  --out dd-test-optimization-intake.json \
  --html dd-test-optimization-report.html \
  > "$INTAKE_LOG" 2>&1 &

INTAKE_PID=$!
echo "$INTAKE_PID" > dd-intake.pid

sleep 2
cat "$INTAKE_LOG"
```

Extract and persist startup values:

Verbatim:

```bash
# Run after the launch block above completes.
set -e

INTAKE_LOG="$(cat dd-intake-log-path.txt)"
INTAKE_URL="$(sed -n 's/^Intake URL: //p' "$INTAKE_LOG" | tail -n 1)"
SHUTDOWN_URL="$(sed -n 's/^Shutdown URL: //p' "$INTAKE_LOG" | tail -n 1)"
HTML_REPORT_FILE_URL="$(sed -n 's/^HTML report: //p' "$INTAKE_LOG" | tail -n 1)"
HTML_REPORT_PATH="$(sed -n 's/^HTML report path: //p' "$INTAKE_LOG" | tail -n 1)"

if [ -z "$INTAKE_URL" ] || [ -z "$SHUTDOWN_URL" ]; then
  echo "Fake intake did not print an intake URL or shutdown URL. Check $INTAKE_LOG before continuing." >&2
  exit 1
fi

echo "$INTAKE_URL" > dd-intake-url.txt
echo "$SHUTDOWN_URL" > dd-intake-shutdown-url.txt
echo "$HTML_REPORT_FILE_URL" > dd-intake-html-file-url.txt
echo "$HTML_REPORT_PATH" > dd-intake-html-path.txt

printf 'Intake URL: %s\n' "$INTAKE_URL"
printf 'Shutdown URL: %s\n' "$SHUTDOWN_URL"
printf 'HTML report: %s\n' "$HTML_REPORT_FILE_URL"
printf 'HTML report path: %s\n' "$HTML_REPORT_PATH"
```

The command prints:

- the intake URL, such as `http://127.0.0.1:54321`
- the artifact path
- the HTML report `file://` URL
- the absolute HTML report path
- the command to open the HTML report
- the shutdown URL, including the shutdown token

It persists the values needed later in `dd-intake-url.txt`, `dd-intake-shutdown-url.txt`,
`dd-intake.pid`, `dd-intake-log-path.txt`, `dd-intake-html-file-url.txt`, and
`dd-intake-html-path.txt`.

Keep the intake process running while tests execute. Read these state files in later steps. If
`dd-intake-url.txt` or `dd-intake-shutdown-url.txt` is empty, read the log path stored in
`dd-intake-log-path.txt` and fix the intake startup before running tests.

If background child processes are reaped when the shell command exits, use the Preferred Wrapper
or start `test-optimization-intake.js` in a persistent foreground exec session. Keep that session
running until Step 5 stops the intake.

The HTML report is a static, self-contained file. The intake rewrites it as requests arrive and
again when the intake stops. It can be opened directly from disk and does not require the intake
server after the run is complete.

Use the shutdown URL to stop the fake intake and flush final artifacts after the selected test
command finishes. Do not rely on process listing or an interactive `Ctrl-C` path.

If intake startup fails with `listen EPERM 127.0.0.1`, request permission to bind `127.0.0.1` or
use the environment's supported local-server path.

### 4. Run the selected test subset against the fake intake

For this diagnosis flow, always run the selected test command with `dd-trace/ci/init` preloaded
through `NODE_OPTIONS`. Do not rely on `require("dd-trace/ci/init")`, do not modify test files to
load it, and do not run the live intake check without the preload.

Use the selected test command with local agentless routing:

Check that the fake intake is still running:

Verbatim:

```bash
INTAKE_PID="$(cat dd-intake.pid)"
if kill -0 "$INTAKE_PID" 2>/dev/null; then
  echo "Intake running"
else
  echo "Intake not running - restart Step 3 before continuing"
  echo "If this is Operation not permitted, retry Step 4 in the same privilege context used to start the intake."
  exit 1
fi
```

Apply this `NODE_OPTIONS` decision table:

- Selected command is Vitest, selected npm script invokes Vitest, or Vitest is the only detected
  framework: include `--import dd-trace/register.js`.
- Existing `NODE_OPTIONS` is present: keep it and append the Test Optimization preload.
- Otherwise: use only `-r dd-trace/ci/init`.

Run the selected command:

Verbatim:

```bash
set -e

INTAKE_URL="$(cat dd-intake-url.txt)"
TEST_COMMAND="$(cat dd-test-optimization-test-command.txt)"
TEST_OUTPUT=dd-test-optimization-test-output.txt
IS_VITEST="$(node -e '
const fs = require("node:fs")
const d = JSON.parse(fs.readFileSync("dd-test-optimization-static.json", "utf8"))
const testCommand = fs.readFileSync("dd-test-optimization-test-command.txt", "utf8")
const frameworks = d.supportedFrameworks || []
const packageJson = readPackageJson()
const scriptName = getNpmScriptName(testCommand)
const scriptBody = scriptName && packageJson.scripts ? packageJson.scripts[scriptName] || "" : ""
const commandText = `${testCommand}\n${scriptBody}`
const onlyVitest = frameworks.length === 1 && frameworks[0].id === "vitest"
console.log(/\bvitest\b/i.test(commandText) || onlyVitest ? "1" : "0")

function readPackageJson () {
  try {
    return JSON.parse(fs.readFileSync("package.json", "utf8"))
  } catch {
    return {}
  }
}

function getNpmScriptName (command) {
  const npmRunMatch = command.match(/\bnpm\s+run\s+([^\s]+)/)
  if (npmRunMatch) return npmRunMatch[1]
  if (/\bnpm\s+test\b/.test(command)) return "test"
}
')"
VITEST_NODE_OPTIONS=""

if [ "$IS_VITEST" = "1" ]; then
  VITEST_NODE_OPTIONS="--import dd-trace/register.js "
fi

NODE_OPTIONS_VALUE="${NODE_OPTIONS:+$NODE_OPTIONS }${VITEST_NODE_OPTIONS}-r dd-trace/ci/init"

cat > dd-test-optimization-env.txt <<EOF
DD_API_KEY=debug
DD_SERVICE=dd-test-optimization-debug
DD_CIVISIBILITY_AGENTLESS_ENABLED=1
DD_CIVISIBILITY_AGENTLESS_URL=$INTAKE_URL
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false
NODE_OPTIONS=$NODE_OPTIONS_VALUE
EOF

set +e # allow non-zero test exit; capture it manually
DD_API_KEY=debug \
DD_SERVICE=dd-test-optimization-debug \
DD_CIVISIBILITY_AGENTLESS_ENABLED=1 \
DD_CIVISIBILITY_AGENTLESS_URL="$INTAKE_URL" \
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false \
NODE_OPTIONS="$NODE_OPTIONS_VALUE" \
sh -c "$TEST_COMMAND" > "$TEST_OUTPUT" 2>&1
TEST_EXIT_CODE=$?
cat "$TEST_OUTPUT"
printf '%s\n' "$TEST_EXIT_CODE" > dd-test-optimization-test-exit-code.txt

node -e '
const fs = require("node:fs")
const text = fs.readFileSync("dd-test-optimization-test-output.txt", "utf8")
const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse()
const summary = lines.find(line => /\b\d+\s+(passing|failing|failed|passed|pending|skipped)\b/i.test(line) ||
  /\b\d+\s+tests?\s+(passed|failed|skipped)\b/i.test(line)) || "unknown"
console.log(summary)
' > dd-test-optimization-test-result.txt
```

Always inject `NODE_OPTIONS` explicitly in the live intake check. Always inject `DD_API_KEY=debug`;
the static diagnosis cannot reliably detect whether the test process will receive one.

Some local development copies of `dd-trace/ci/init` may print extra stdout before the test runner
output. Ignore harmless informational lines. Do not ignore warnings about a missing API key or
disabled CI Visibility reporting.

### 5. Stop the fake intake and keep the HTML link

MUST NOT format the local HTML report as a Markdown link. Print the plain `file://` URL and the
absolute path.

After the test command exits, request the exact `SHUTDOWN_URL` extracted from the intake startup
log. The URL includes the random shutdown token. Do not invent the token and do not reconstruct the
URL unless the startup log is unavailable.

Verbatim:

```bash
SHUTDOWN_URL="$(cat dd-intake-shutdown-url.txt)"

node -e "fetch(process.argv[1]).then(r => r.text()).then(console.log)" "$SHUTDOWN_URL"
```

This writes the final JSON artifact and final HTML report, then closes the fake intake. If the
shutdown URL cannot be reached but the test command already finished, try to stop only the
background process you started:

Verbatim:

```bash
INTAKE_PID="$(cat dd-intake.pid)"

kill -INT "$INTAKE_PID"
```

If shutdown returns `ECONNREFUSED` but `dd-test-optimization-intake.json` and
`dd-test-optimization-report.html` exist, continue and explain that the intake was already gone.
If both shutdown paths fail, continue with the current artifact and explicitly mention that the
final `stoppedAt` timestamp may be missing. The artifact and HTML report are rewritten after each
captured request.

Do not depend on opening the HTML report to make the diagnosis. Use the analyzer in the next step.

Do not use Browser MCP, Chrome DevTools, an in-app browser API, or any browser automation tool to
open the HTML report. Step 6 runs a best-effort local open attempt through the analyzer. If the
open attempt fails, continue; opening the HTML file is not part of the diagnosis.

Reporting the HTML report file URL is required even when opening it fails. Do not only mention the
relative filename. Copy the `HTML report: file:///...` line printed by the intake or analyzer
exactly. Also include the raw absolute path:

```text
HTML report: file:///absolute/path/to/dd-test-optimization-report.html
HTML report path: /absolute/path/to/dd-test-optimization-report.html
```

This is intentionally plain terminal output, not Markdown. The HTML report does not need network
access or a running HTTP server.

### 6. Run the fixed analyzer

Run both analyzer commands.

6a. Run plain text analyzer output and best-effort HTML open attempt:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-analyze-intake.js \
  dd-test-optimization-intake.json \
  --out dd-test-optimization-agent-report.txt \
  --open
```

6b. Run structured analyzer output for decision-tree field names:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-analyze-intake.js \
  dd-test-optimization-intake.json \
  --json > dd-test-optimization-agent-report.json
```

6c. Render the final report:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-render-report.js \
  --static dd-test-optimization-static.json \
  --intake dd-test-optimization-intake.json \
  --test-command-file dd-test-optimization-test-command.txt \
  --test-exit-code-file dd-test-optimization-test-exit-code.txt \
  --test-result-file dd-test-optimization-test-result.txt \
  --env-file dd-test-optimization-env.txt \
  --agent-report dd-test-optimization-agent-report.txt \
  --agent-json-report dd-test-optimization-agent-report.json \
  --out dd-test-optimization-final-report.txt
```

The renderer prints the final report to stdout and also writes `dd-test-optimization-final-report.txt`.

Use the final report renderer output, not the browser, as the source of the final diagnosis. Use
the JSON analyzer output when traversing the decision tree. The `--open` attempt in 6a is
best-effort and non-fatal.

After rendering, check the final report's `Consistency checks` section. The intake URL from
`dd-test-optimization-env.txt`, the intake URL from `dd-test-optimization-intake.json`, and the raw
artifact request count versus analyzer request count should be `ok`. Treat mismatches as
artifact/state problems before applying funnel-stage fixes.

- If the intake URL check is `mismatch`, rerun from Step 0; the env file and intake artifact came
  from different runs.
- If the request count check is `mismatch`, rerun Step 6 from the current
  `dd-test-optimization-intake.json`; if it still mismatches, rerun from Step 0.
- If consistency checks are `ok` and the stage is still `Nothing`, use the matching decision-tree
  stage below.

If the primary stage is anything other than `Reporting complete`, consult `## Decision Tree` below
Step 8 under the matching stage heading before writing the final response.

The first line of the analyzer text report is the canonical HTML report `file://` URL. Copy that
line exactly into the final response instead of rewriting it from memory. The second line is the
absolute HTML report path, and the third line is the suggested open command for the HTML report.

### 7. Test Early Flake Detection

Run this step after the basic reporting result is `Reporting complete`. If basic reporting is not
complete, do not run EFD yet; fix the basic reporting funnel first.

EFD requires two runs:

- First run: capture the currently known tests from the selected subset.
- Second run: serve those known tests, add one new deterministic passing test, and verify that the
  new test is retried.

Step 7 always runs the wrapper again with `--out-dir`; do not reuse the root wrapper artifact as the
EFD baseline.

7a. Run the first baseline run in its own artifact directory and extract known tests:

Required: use `--out-dir "$BASIC_DIR"` to avoid overwriting root artifacts. It prevents the
baseline EFD run from overwriting the root wrapper artifacts used for Step 8.

Verbatim:

```bash
set -e

BASIC_DIR=dd-test-optimization-basic
TEST_COMMAND="$(cat dd-test-optimization-test-command.txt)"

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command "$TEST_COMMAND" \
  --out-dir "$BASIC_DIR" \
  --no-open

node ./node_modules/dd-trace/ci/test-optimization-analyze-intake.js \
  "$BASIC_DIR/dd-test-optimization-intake.json" \
  --json \
  --known-tests-out dd-test-optimization-known-tests.json \
  > "$BASIC_DIR/dd-test-optimization-agent-report.json"

node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-basic/dd-test-optimization-agent-report.json", "utf8"))
if (report.primaryStage !== "Reporting complete") {
  console.error(`First EFD baseline run must be Reporting complete, got: ${report.primaryStage}`)
  process.exit(1)
}
const knownTests = JSON.parse(fs.readFileSync("dd-test-optimization-known-tests.json", "utf8"))
console.log(JSON.stringify(knownTests, null, 2))
'
```

7b. Add one new deterministic passing test that is not present in
`dd-test-optimization-known-tests.json`.

Adapt:

- Use a unique test name, for example `dd trace EFD debug temporary test`.
- Prefer creating the temporary test next to a clean selected test file. Avoid appending to or
  creating siblings beside user-modified files when a clean test file can be selected instead.

EFD test insertion decision:

| Condition | Action |
| --- | --- |
| The runner accepts multiple file arguments | Create a temporary sibling test file next to the selected test file. |
| The runner cannot accept an additional file | Append one temporary test case to the selected test file. |

Ensure the second command selects both the previously known tests and the new test. Record how to
remove the temporary test after the EFD check.

Common direct-file-runner example for Mocha, Jest, and Vitest:

- If the first command is `npm test -- test/sum.spec.js`, create a temporary sibling test file such
  as `test/dd-trace-efd-debug.spec.js`.
- Put one deterministic passing test in that file with the name `dd trace EFD debug temporary test`.
- Use `npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js` for the second EFD command.
- Remove `test/dd-trace-efd-debug.spec.js` after Step 7d passes.

Yarn example:

- If the first command is `yarn test test/sum.spec.js`, create `test/dd-trace-efd-debug.spec.js`.
- Use `yarn test test/sum.spec.js test/dd-trace-efd-debug.spec.js` for the second EFD command.
- Remove `test/dd-trace-efd-debug.spec.js` after Step 7d passes.

Temporary test templates:

Mocha or Jest CommonJS:

```js
'use strict'

const assert = require('node:assert/strict')

describe('dd trace EFD debug', () => {
  it('dd trace EFD debug temporary test', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
```

Vitest:

```js
import { describe, expect, it } from 'vitest'

describe('dd trace EFD debug', () => {
  it('dd trace EFD debug temporary test', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Cypress:

```js
describe('dd trace EFD debug', () => {
  it('dd trace EFD debug temporary test', () => {
    expect(1 + 1).to.equal(2)
  })
})
```

After creating a temporary sibling test file, write and verify its path:

Adapt:

```bash
EFD_TEMP_TEST_FILE='FILL_IN' # replace FILL_IN with the temporary test file path, for example: test/dd-trace-efd-debug.spec.js
if [ "$EFD_TEMP_TEST_FILE" = 'FILL_IN' ] || [ -z "$EFD_TEMP_TEST_FILE" ]; then
  echo "Replace FILL_IN with the temporary EFD test file path before continuing."
  exit 1
fi
test -f "$EFD_TEMP_TEST_FILE"
printf 'Temporary EFD test file: %s\n' "$EFD_TEMP_TEST_FILE"
printf '%s\n' "$EFD_TEMP_TEST_FILE" > dd-test-optimization-efd-temp-test-file.txt
```

If the runner required appending a temporary test case to an existing file instead of creating a
temporary sibling file, record the cleanup command in the final response and verify cleanup with a
repository-specific command after Step 7d.

Write the second command:

Adapt:

```bash
EFD_TEST_COMMAND='FILL_IN' # replace FILL_IN with a command that runs the first-run tests plus the new test
if [ "$EFD_TEST_COMMAND" = 'FILL_IN' ] || [ -z "$EFD_TEST_COMMAND" ]; then
  echo "Replace FILL_IN with the EFD test command before continuing."
  exit 1
fi
printf 'EFD test command: %s\n' "$EFD_TEST_COMMAND"
printf '%s\n' "$EFD_TEST_COMMAND" > dd-test-optimization-efd-command.txt
```

7c. Run the second EFD run with known tests from the first run:

Required: use `--out-dir "$EFD_DIR"` to avoid overwriting root artifacts. It prevents the second
EFD run from overwriting the root wrapper artifacts and the first EFD baseline artifacts.

Verbatim:

```bash
set -e

EFD_DIR=dd-test-optimization-efd
EFD_TEST_COMMAND="$(cat dd-test-optimization-efd-command.txt)"

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command "$EFD_TEST_COMMAND" \
  --settings-mode efd \
  --known-tests dd-test-optimization-known-tests.json \
  --out-dir "$EFD_DIR" \
  --no-open
```

The EFD fake settings endpoint returns:

```json
{
  "early_flake_detection": {
    "enabled": true,
    "slow_test_retries": {
      "5s": 3
    }
  },
  "known_tests_enabled": true
}
```

The known-tests endpoint returns the contents of `dd-test-optimization-known-tests.json` as:

```json
{
  "data": {
    "attributes": {
      "tests": {
        "<test.framework>": {
          "<test.suite>": ["<test.name>"]
        }
      }
    }
  }
}
```

7d. Validate the EFD result:

Verbatim:

```bash
node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-efd/dd-test-optimization-agent-report.json", "utf8"))
if (report.primaryStage !== "EFD retried new test") {
  console.error(`Second EFD run must reach "EFD retried new test", got: ${report.primaryStage}`)
  process.exit(1)
}
if (!report.summary.efd.settingsEnabled) {
  console.error("EFD settings were not enabled in the second run.")
  process.exit(1)
}
if (!report.summary.efd.requested) {
  console.error("The second run did not request known tests.")
  process.exit(1)
}
if (report.summary.efd.knownTestsReceived === 0) {
  console.error("The second run received zero known tests.")
  process.exit(1)
}
if (report.summary.efd.retriedNewTests === 0) {
  console.error("No new test was retried by EFD.")
  process.exit(1)
}
console.log(`EFD retried new tests: ${report.summary.efd.retriedNewTests}`)
console.log(`Retried new test names: ${report.summary.efd.retriedNewTestNames.join(", ")}`)
'
```

If this validation passes, report that EFD works for the selected subset.

Remove and verify a temporary sibling test file. Remove the file recorded in
`dd-test-optimization-efd-temp-test-file.txt`.

Verbatim:

```bash
if [ -f dd-test-optimization-efd-temp-test-file.txt ]; then
  EFD_TEMP_TEST_FILE="$(cat dd-test-optimization-efd-temp-test-file.txt)"
  rm -f "$EFD_TEMP_TEST_FILE"
  test ! -e "$EFD_TEMP_TEST_FILE"
  printf 'Temporary EFD test removed: %s\n' "$EFD_TEMP_TEST_FILE"
fi
```

If the EFD test was appended to an existing file, remove only the temporary test case and run the
repository-specific cleanup verification recorded in Step 7b.

### 8. Report back

If the wrapper path was used, include the wrapper final report output or
`dd-test-optimization-final-report.txt` in the final response. If manual Steps 3-6 were used,
include the Step 6c stdout report. Do not `cat` `dd-test-optimization-final-report.txt` after Step
6c; that duplicates the same report. Add notable weird cases not represented in the generated
report only when needed.

Report static warnings and errors from the initial root `dd-test-optimization-static.json`. If the
wrapper is run without Step 1, use the wrapper-generated root `dd-test-optimization-static.json`.
Do not switch to `dd-test-optimization-basic/dd-test-optimization-static.json` or
`dd-test-optimization-efd/dd-test-optimization-static.json` unless the difference is the notable
case being reported.

Use this extractor to assemble the required fields from the root and EFD artifacts:

Verbatim:

```bash
node -e '
const fs = require("node:fs")

function readJson (path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function readText (path, fallback = "unknown") {
  try {
    return fs.readFileSync(path, "utf8").trim() || fallback
  } catch {
    return fallback
  }
}

function countEvent (report, eventType) {
  return report?.summary?.events?.counts?.[eventType] || 0
}

function readFinalReportLine (prefix) {
  const finalReport = readText("dd-test-optimization-final-report.txt", "")
  const line = finalReport.split(/\r?\n/).find(line => line.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : "unknown"
}

const basic = readJson("dd-test-optimization-agent-report.json", {})
const efd = readJson("dd-test-optimization-efd/dd-test-optimization-agent-report.json", {})
const staticReport = readJson("dd-test-optimization-static.json", { results: [] })
const staticFindings = (staticReport.results || [])
  .filter(result => result.status === "error" || result.status === "warning")
  .map(result => `${result.status}: ${result.title}`)
const decodeErrors = Array.isArray(basic.summary?.decodeErrors)
  ? basic.summary.decodeErrors.length
  : basic.summary?.decodeErrors || 0
const eventLevels =
  `sessions=${countEvent(basic, "test_session_end")}, ` +
  `modules=${countEvent(basic, "test_module_end")}, ` +
  `suites=${countEvent(basic, "test_suite_end")}, ` +
  `tests=${countEvent(basic, "test")}`

console.log(`HTML report: ${readText("dd-intake-html-file-url.txt", readFinalReportLine("HTML report:"))}`)
console.log(`HTML report path: ${readText("dd-intake-html-path.txt", readFinalReportLine("HTML report path:"))}`)
console.log(`Final report path: ${process.cwd()}/dd-test-optimization-final-report.txt`)
console.log(`Selected test command: ${readText("dd-test-optimization-test-command.txt")}`)
console.log(`Test result: ${readText("dd-test-optimization-test-result.txt")}`)
console.log(`Basic primary stage: ${basic.primaryStage || "unknown"}`)
console.log(`Basic requests: ${basic.summary?.requestCount ?? "unknown"}`)
console.log(`Event levels: ${eventLevels}`)
console.log(`Decode errors: ${decodeErrors}`)
console.log(`EFD status: ${efd.primaryStage === "EFD retried new test" ? "passed" : efd.primaryStage ? "failed" : "not run"}`)
console.log(`EFD known tests received: ${efd.summary?.efd?.knownTestsReceived ?? "n/a"}`)
console.log(`EFD retried new tests: ${efd.summary?.efd?.retriedNewTests ?? "n/a"}`)
console.log(`EFD retried new test names: ${(efd.summary?.efd?.retriedNewTestNames || []).join(", ") || "none"}`)
console.log(`Static warnings/errors: ${staticFindings.join("; ") || "none"}`)
'
```

Frameworks can report test names with nested suite or `describe` text already included. Repeated
words in `EFD retried new test names` are not automatically malformed; compare them with the
selected temporary test's suite and test names.

The final response must include:

- HTML report `file://` URL and absolute path.
- Final report path.
- Selected test command and test result.
- EFD check result when Step 7 ran, including known tests count and retried new tests count.
- The four diagnostic question answers with each question text inline.
- Static warnings and errors.
- Recommended next actions.
- Cleanup confirmation for any temporary EFD test file.

Final response template:

```text
HTML report: file:///absolute/path/to/dd-test-optimization-report.html
HTML report path: /absolute/path/to/dd-test-optimization-report.html
Final report path: /absolute/path/to/dd-test-optimization-final-report.txt

Selected test command:
<command>

Test result:
<one-line result>

Basic reporting:
Primary stage: <stage>
Requests: <count>
Event levels: sessions=<count>, modules=<count>, suites=<count>, tests=<count>
Decode errors: <count>

EFD check:
Status: <not run | passed | failed>
Known tests received: <count>
Retried new tests: <count>
Retried new test names: <names or none>

Diagnostic answers:
- Is dd-trace installed and statically configured in a supported way? <answer>
- Does dd-trace/ci/init reach the test process through NODE_OPTIONS? <answer>
- Does a small test subset send Test Optimization requests to a local fake intake? <answer>
- If data is reported, does it include session, module, suite, and test events? <answer>

Static warnings/errors:
- <finding>

Recommended next actions:
- <action>

Notable execution cases:
- <only include if needed>

Cleanup confirmation:
- Temporary EFD test removed: <yes | not created | no, explain>
```

## Decision Tree

The field names in this decision tree match `dd-test-optimization-agent-report.json`, not the raw
intake artifact. Use `dd-test-optimization-agent-report.txt` for the final summary and
`dd-test-optimization-agent-report.json` for rule traversal.

To traverse the tree, read `primaryStage` from `dd-test-optimization-agent-report.json` and search
for `### Stage: <primaryStage>`. Then confirm the observation fields under that stage.

### Stage: Nothing

Observation: `anyRequestReceived: false`

Cause: tracer not loaded into the test process, not pointed at the intake, or tests never ran.

Fix: check `NODE_OPTIONS="-r dd-trace/ci/init"` reached the test process. Cypress and Playwright
may wire processes differently. Confirm the command actually executed tests.

Check for loopback networking failures when `NODE_OPTIONS` reached the test process, tests passed,
and the fake intake still captured zero requests. Both the intake process and the test process need
loopback access.

For ambiguous `Nothing` results, rerun the same selected test command with debug logging:

```bash
INTAKE_URL="$(cat dd-intake-url.txt)"
TEST_COMMAND="$(cat dd-test-optimization-test-command.txt)"

DD_TRACE_DEBUG=true DD_TRACE_LOG_LEVEL=debug \
DD_API_KEY=debug \
DD_SERVICE="${DD_SERVICE:-dd-test-optimization-debug}" \
DD_CIVISIBILITY_AGENTLESS_ENABLED=1 \
DD_CIVISIBILITY_AGENTLESS_URL="$INTAKE_URL" \
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false \
NODE_OPTIONS="-r dd-trace/ci/init" \
sh -c "$TEST_COMMAND"
```

If debug logs show `connect EPERM 127.0.0.1:PORT`, report a sandbox loopback permission
problem instead of a tracer initialization failure.

### Stage: Connected, No Settings

Observation: only `/info` seen.

Cause: exporter init failed or EVP proxy was not detected.

Fix: check agent vs agentless routing. Agent-proxy mode needs EVP v2 on the agent.

### Stage: Settings, Empty Git

Observation: `metadata.emptyFields` has `repositoryUrl`, `commitSha`, or `branch`.

Cause: git extraction failed because there is no git binary, a shallow clone, detached HEAD, or no CI env.

Fix: cross-reference the static diagnosis git section. Unshallow the checkout or set `DD_GIT_*`.

### Stage: No Session Spans

Observation: `citestcycle.payloadCount: 0`.

Cause: spans were generated but not flushed, the process was killed before flush, or encoding failed.

Fix: check `decodeErrors`; verify clean process exit and flush behavior.

### Stage: Incomplete Test Event Levels

Observation: `citestcycle.payloadCount > 0`, but one or more of `test_session_end`,
`test_module_end`, `test_suite_end`, or `test` is missing.

Cause: the tracer reported payloads, but instrumentation did not emit all expected levels for the
selected test command.

Fix: confirm the selected command runs a normal test session and that framework instrumentation
emits session, module, suite, and test events.

### Stage: Session, No Test Spans

Observation: `test_session_end: 1`, `test: 0`.

Cause: per-test hooks did not fire because of custom `testEnvironment` or runner config, unsupported
configuration, or the filter matched no tests.

Fix: fix framework configuration and confirm the subset actually selects tests.

### Stage: Unlinked Test Spans

Observation: `unlinkedTestSpans > 0`.

Cause: encoder version mismatch or partial instrumentation.

Fix: check versions and escalate with the payload.

### Stage: Reporting Complete

Observation: `citestcycle.payloadCount > 0` and session, module, suite, and test events are all
present.

Cause: the basic Test Optimization reporting path is working for the selected command.

Fix: no basic reporting fix is needed. Run Step 7 to validate EFD. Defer ITR, test skipping, test
management, and coverage analysis to a later runbook version.

### Stage: EFD Retry Missing

Observation: `efd.retriedNewTests: 0`.

Cause: EFD settings and known-tests request flow ran, but no new test retry event was captured.

Fix: verify the second run served known tests from the first run, the temporary test was absent
from `dd-test-optimization-known-tests.json`, and the second command selected the new test.

### Stage: EFD Retried New Test

Observation: `efd.retriedNewTests > 0`.

Cause: EFD marked a test as new and retried it.

Fix: no EFD retry fix is needed for the selected subset.

## Agent Judgment

The fixed rules are deliberately conservative. Use agent judgment when:

- the repository wraps test commands in custom scripts
- tests spawn worker processes or child processes
- framework-specific config changes process boundaries
- the static diagnosis and intake artifact disagree
- requests arrive but payload content looks malformed or unexpectedly sparse

When reality is messier than the rule, keep the artifact and explain the evidence rather than
guessing from symptoms alone.
