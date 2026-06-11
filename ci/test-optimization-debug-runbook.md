# Test Optimization Debug Runbook for Coding Agents

This runbook is to diagnose Datadog Test Optimization setup problems in a JavaScript repository.
Use repository-specific judgment to adapt commands.

Objective: by the end, produce local fake-intake evidence that this repository reports test
sessions, modules, suites, and tests, and optionally validates the advanced Test Optimization
features against generated temporary tests.

What this runbook produces:

- One combined Datadog validation relative path, `ci/test/validation#pako:{payload}`.
- A local HTML report, `dd-test-optimization-report.html`.
- A text final report, `dd-test-optimization-final-report.txt`.
- A compact summary, `dd-test-optimization-summary.txt`.
- Cleanup verification for generated source files.

Terms:

- EFD: Early Flake Detection, which marks a newly discovered test as new and retries it.
- ATR: Auto Test Retries, which retries known flaky tests and reports retry metadata.
- TIA/ITR: Test Impact Analysis / Intelligent Test Runner, the coverage-backed test selection and
  skipping flow.
- Test Management: Datadog-backed disabled, quarantined, and attempt-to-fix test behavior.

## Runbook and Script Location

The invoking prompt should locate this runbook before asking the agent to execute it. Once this
file is open, do not search for it again.

Recommended invoking prompt:

```text
Find dd-trace/ci/test-optimization-debug-runbook.md in the installed dependencies. Try ./node_modules/dd-trace/ci/test-optimization-debug-runbook.md first. If that path is missing, use package-manager-dependent resolution for Yarn/PnP/portal/link installs. Then read and execute the runbook.
```

Treat the directory containing this file as the published `ci` script directory. Keep
`NODE_OPTIONS="-r dd-trace/ci/init"` as a package preload; do not replace it with a file path.

Set the script directory before Step 0. This block tries `node_modules`, then a dd-trace source
checkout, then `require.resolve` through `yarn node` for Yarn PnP repositories or through `node`
otherwise:

```bash
if [ -f ./node_modules/dd-trace/ci/test-optimization-debug-runbook.md ]; then
  DD_TRACE_RUNBOOK='./node_modules/dd-trace/ci/test-optimization-debug-runbook.md'
elif [ -f ./ci/test-optimization-debug-runbook.md ]; then
  DD_TRACE_RUNBOOK='./ci/test-optimization-debug-runbook.md'
else
  DD_TRACE_RESOLVE_SCRIPT='
const path = require("node:path")
try {
  process.stdout.write(require.resolve("dd-trace/ci/test-optimization-debug-runbook.md"))
} catch {
  const packagePath = require.resolve("dd-trace/package.json")
  process.stdout.write(path.join(path.dirname(packagePath), "ci/test-optimization-debug-runbook.md"))
}
'
  if [ -f .pnp.cjs ] || [ -f .pnp.loader.mjs ]; then
    DD_TRACE_RUNBOOK="$(yarn node -e "$DD_TRACE_RESOLVE_SCRIPT")"
  else
    DD_TRACE_RUNBOOK="$(node -e "$DD_TRACE_RESOLVE_SCRIPT")"
  fi
fi

if [ ! -f "$DD_TRACE_RUNBOOK" ]; then
  echo "Could not resolve dd-trace/ci/test-optimization-debug-runbook.md from installed dependencies." >&2
  exit 1
fi

DD_TRACE_CI_DIR="$(cd "$(dirname "$DD_TRACE_RUNBOOK")" && pwd)"
DD_TRACE_NODE=node
if [ -f .pnp.cjs ] || [ -f .pnp.loader.mjs ]; then
  DD_TRACE_NODE='yarn node'
fi

test -f "$DD_TRACE_CI_DIR/test-optimization-debug-runbook.md"
printf '%s\n' "$DD_TRACE_CI_DIR" > dd-test-optimization-ci-dir.txt
printf '%s\n' "$DD_TRACE_NODE" > dd-test-optimization-node-command.txt
printf 'dd-trace ci scripts: %s\n' "$DD_TRACE_CI_DIR"
```

Later commands read `dd-test-optimization-ci-dir.txt` and
`dd-test-optimization-node-command.txt` so Yarn PnP repositories can run the published scripts
through `yarn node` even when the agent runs each command block in a fresh shell.

## Start Here

This section is the canonical entry point. The detailed section index later in this file is
reference material for the steps named here.

A successful run reports session, module, suite, and test events for one small test subset, then
proves EFD, Auto Test Retries, and the three Test Management modes using generated temporary tests,
with all temporary source changes restored.

Minimal validation stops after Step 9 once the Preferred Wrapper reports `Reporting complete`.
Full advanced validation continues through Step 7 and Step 8 before Step 9.

Use this path:

1. Run Step 0 cleanup and source-edit restore safety.
2. Run Step 2 to choose one small test command.
3. Run the Preferred Wrapper.
4. If the wrapper reports `Reporting complete`, run Step 7 for EFD and Auto Test Retries.
5. If the wrapper reports `Reporting complete`, run Step 8 for Test Management.
6. Run Step 9 and report the diagnostic answers with each question text inline.

Wrapper result routing:

| Root wrapper result | Next action |
| --- | --- |
| `listen EPERM: operation not permitted 127.0.0.1` | Rerun the wrapper with loopback bind/connect approval. Do not diagnose Test Optimization from this result. |
| `connect EPERM 127.0.0.1:PORT` in debug logs | Rerun the wrapper with loopback bind/connect approval. The fake intake or test process was blocked locally. |
| `Reporting complete` | Run Step 7 to validate EFD and Auto Test Retries, run Step 8 for Test Management, then Step 9. |
| `Nothing` | Confirm the selected test ran and `NODE_OPTIONS` reached it. Use the manual fallback/debug path only when those are true and the wrapper still captures no requests. Then run Step 9. |
| Any other stage | Skip Step 7 and Step 8, consult the matching Decision Tree stage, then run the Step 9 extractor. |

Manual fallback trigger: run manual Steps 3-6 only when the wrapper is unavailable, fails before
producing artifacts, reports `Nothing` after a confirmed test run, or requires repository-specific
process handling.

Happy path command list:

1. Set `dd-test-optimization-ci-dir.txt` and `dd-test-optimization-node-command.txt` from the
   runbook location block above.
2. Run Step 0 cleanup.
3. Run Step 2 and write `dd-test-optimization-test-command.txt` and
   `dd-test-optimization-selected-test-files.txt`.
4. Run the Preferred Wrapper.
5. If the root stage is `Reporting complete`, run Step 7.
6. If Step 7 passes, run Step 8 for `disabled`, `quarantined`, and `attempt-to-fix`.
7. Run Step 9 and report the extractor output plus any agent adaptations.

Wrapper happy path command skeleton:

For common npm/yarn repositories where `scripts.test` accepts file arguments, replace only
`SELECTED_TEST_COMMAND` and `SELECTED_TEST_FILES`, then run the block after Step 0 cleanup.

```bash
set -e

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/diagnose.js" --json --fail-on=never > dd-test-optimization-static.json

SELECTED_TEST_COMMAND='FILL_IN_SELECTED_TEST_COMMAND'
SELECTED_TEST_FILES='FILL_IN_SELECTED_TEST_FILES_ONE_PER_LINE'
if [ "$SELECTED_TEST_COMMAND" = 'FILL_IN_SELECTED_TEST_COMMAND' ] || [ -z "$SELECTED_TEST_COMMAND" ]; then
  echo "Select one small test command before running the wrapper." >&2
  exit 1
fi
printf '%s\n' "$SELECTED_TEST_COMMAND" > dd-test-optimization-test-command.txt
printf '%s\n' "$SELECTED_TEST_FILES" > dd-test-optimization-selected-test-files.txt

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-test-command.txt \
  --no-open

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-agent-report.json", "utf8"))
console.log(`Basic primary stage: ${report.primaryStage}`)
'
```

Continue to Step 7 only when this wrapper run reports `Reporting complete`.
When live fake-intake evidence reaches `Reporting complete`, static diagnosis warnings are
advisory. Report static warnings as context, not blockers.

## Execution Notes

Loopback prerequisite: if the first wrapper command returns
`listen EPERM: operation not permitted 127.0.0.1`, rerun that command with loopback bind/connect
approval. After loopback approval has been granted once, run every later wrapper command with that
approval immediately.

Commands that need loopback approval are wrapper commands that run
`$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js"`.
Analyzer, prepare, restore, and extractor commands read artifacts or edit files; they do not bind
the fake intake or run the test process against it.

For Codex, Claude Code, and other sandboxed command runners: request loopback/escalated approval
only for wrapper commands that bind or connect to `127.0.0.1`. Keep cleanup, discovery, analyzer,
prepare, and restore commands in the normal sandbox unless they fail for a non-loopback permission
reason.

For inferred Jest generated multi-file commands, the helpers append `--runInBand` automatically.
Use `--force-run-in-band` only when explicit custom helper arguments or repository-specific command
overrides produce multi-file Jest runs that lose suite/test spans.

Step 1 is optional on the wrapper path. Run Step 1 only when static diagnosis is useful before
choosing the selected test command. The root wrapper always writes
`dd-test-optimization-static.json`.

Do not run manual Steps 3-6 after a wrapper run reports `Reporting complete`; go directly to
Step 7.

Command categories:

- Read-only diagnostics: Step 1, analyzer commands, validation-link commands, report extractors,
  and helper `--dry-run` commands.
- Temporary source edits: Step 7 helper commands without `--dry-run`, Step 8 helper `--create`,
  and matching restore commands.
- Loopback commands: wrapper commands that start a fake intake and run tests against
  `127.0.0.1`.

## Detailed Section Index

The start section above is the canonical execution flow. The detailed sections below provide
the commands and adaptation rules for each referenced step:

- Step 0: cleanup and source-edit restore safety.
- Step 2: selected test command discovery.
- Preferred Wrapper: root wrapper command details.
- Step 7: advanced EFD and Auto Test Retries checks when basic reporting is complete.
- Step 8: Test Management disabled, quarantined, and attempt-to-fix checks.
- Step 9: machine-oriented extractor and final response format.

The goal is to answer these diagnostic questions:

1. Is `dd-trace` installed and statically configured in a supported way?
2. Does `dd-trace/ci/init` reach the test process through `NODE_OPTIONS`?
3. Does a small test subset send Test Optimization requests to a local fake intake?
4. If data is reported, does it include "all expected test event levels"?
5. Does EFD fetch known tests, mark a new test, and retry it?
6. Does Auto Test Retries retry a failing known test and report retry tags?
7. Does Test Management apply disabled, quarantined, and attempt-to-fix properties?

Diagnostic question map:

- Is `dd-trace` installed and statically configured in a supported way? Step 1.
- Does `dd-trace/ci/init` reach the test process through `NODE_OPTIONS`? Steps 2 and 4.
- Does a small test subset send Test Optimization requests to a local fake intake? Steps 3, 4, and 5.
- If data is reported, does it include session, module, suite, and test events? Step 6.
- Does EFD fetch known tests, mark a new test, and retry it? Step 7.
- Does Auto Test Retries retry a failing known test and report retry tags? Step 7.
- Does Test Management apply disabled, quarantined, and attempt-to-fix properties? Step 8.
- Step 9: synthesize all diagnostic answers.

Required final response checklist:

- HTML report `file://` URL and absolute path.
- One combined Datadog validation relative path.
- Final report path and compact summary path.
- Selected test command, advanced test command when Step 7 ran, and test result.
- Basic reporting counts and decode errors.
- EFD and Auto Test Retries status when Step 7 ran.
- Test Management disabled, quarantined, and attempt-to-fix status when Step 8 ran.
- The diagnostic question answers with each question text inline.
- Static warnings and errors, recommended next actions, and temporary-edit cleanup confirmation.

"All expected test event levels" means:

- `test_session_end`
- `test_module_end`
- `test_suite_end`
- `test`

Do not use a real Datadog API key for this flow. Always route to the local fake intake.

## Preferred Wrapper

Use this wrapper when available. Use `--no-open` by default for coding-agent runs; the HTML report
URL and path are still printed, the final report is still written, and opening the file is not part
of the diagnosis. Do not use browser automation for the local HTML report.

The start section above is the authoritative wrapper flow. Apply the top-level loopback
prerequisite for sandboxed environments.

After completing Step 2, use only the selected-command file form:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-test-command.txt \
  --no-open
```

Sandbox note: `listen EPERM 127.0.0.1` is a local environment permission failure, not a Test
Optimization reporting failure. Use the loopback prerequisite at the top of this runbook.

If the environment records reusable approvals, approve the command prefix for the wrapper:

```text
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js"
```

The wrapper runs the static diagnosis, starts the fake intake in the same Node.js process, runs the
selected test command, stops the intake, writes all artifacts, and renders the final report. With
`--no-open`, it does not try to open the local HTML report. The wrapper writes
`dd-test-optimization-test-command.txt`; later steps read that file instead of asking the agent to
reconstruct the selected command.
The wrapper intentionally overwrites `dd-test-optimization-test-command.txt` with the command it ran.

If the wrapper succeeds and the primary stage is `Reporting complete`, skip manual Steps 3-6 and
continue to Step 7.

Wrapper success produces the same analysis and final-report artifacts that manual Steps 3-6
produce. Use these wrapper-generated root artifacts for Step 9:

- `dd-test-optimization-agent-report.txt`
- `dd-test-optimization-agent-report.json`
- `dd-test-optimization-final-report.txt`
- `dd-test-optimization-intake.json`
- `dd-test-optimization-report.html`

The wrapper and analyzer print a `Datadog validation:` relative path with a pako-compatible
encoded JSON payload. The decoded payload is intentionally small: `status`, `checks[]`, each
check's `steps[]`, optional `artifacts`, and optional `framework`.

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
- `summary.atr.settingsEnabled`
- `summary.atr.failedExecutions`
- `summary.atr.passedExecutions`
- `summary.atr.passedRetryTests`
- `summary.atr.failedThenPassedRetryTests`
- `summary.atr.failedThenPassedRetryTestNames`

For the advanced checks later in this runbook, use wrapper `--out-dir` values so the first and
second runs do not overwrite each other.

The wrapper binds a local fake intake on `127.0.0.1` and the test process connects back to it.

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
- `test-optimization-prepare-advanced.js`: optional helper for common Step 7 temporary test edits.
- `test-optimization-prepare-test-management.js`: helper for Step 8 temporary Test Management tests
  and calibrated properties files.
- `test-optimization-render-report.js`: final customer-facing report renderer.
- `test-optimization-intake-analysis.js`: shared decision-tree rules.

## Expected Output

- Static diagnosis can report `Missing Test Optimization initialization`; the live debug run injects
  `NODE_OPTIONS="-r dd-trace/ci/init"`.
- A successful basic reporting check has primary stage `Reporting complete`.
- Successful basic reporting includes session, module, suite, and test events.
- Successful EFD reports a retried new test.
- Successful Auto Test Retries reports one known flaky test with a failed execution, a passing
  execution, and `test.is_retry=true` on the passing retry.
- Successful Test Management disabled, quarantined, and attempt-to-fix checks each fetch settings,
  call the Test Management properties endpoint, match a calibrated test identity, and report the
  expected managed-test behavior.
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
set -e

if [ -f dd-test-optimization-efd-temp-test-file.txt ] || [ -f dd-test-optimization-atr-flaky-test-file.txt ]; then
  $(cat dd-test-optimization-node-command.txt) \
    "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" \
    --restore
fi

if [ -d dd-test-optimization-test-management ]; then
  $(cat dd-test-optimization-node-command.txt) \
    "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" \
    --restore
fi

if [ -f dd-intake-log-path.txt ]; then
  INTAKE_LOG="$(cat dd-intake-log-path.txt)"
  rm -f "$INTAKE_LOG"
fi

if [ -f dd-test-optimization-atr-flaky-test-file.txt ] && [ -f dd-test-optimization-atr-flaky-test-backup.txt ]; then
  ATR_FLAKY_TEST_FILE="$(cat dd-test-optimization-atr-flaky-test-file.txt)"
  ATR_FLAKY_BACKUP="$(cat dd-test-optimization-atr-flaky-test-backup.txt)"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git status --short -- "$ATR_FLAKY_TEST_FILE" | grep . >/dev/null; then
      git status --short -- "$ATR_FLAKY_TEST_FILE"
      if ! grep -q 'dd trace auto retry debug flake' "$ATR_FLAKY_TEST_FILE" 2>/dev/null; then
        echo "Recorded Auto Test Retries file has local changes but no runbook marker." >&2
        echo "Inspect the recorded file and backup before restoring it." >&2
        exit 1
      fi
    fi
  fi
  if [ -f "$ATR_FLAKY_BACKUP" ]; then
    cp "$ATR_FLAKY_BACKUP" "$ATR_FLAKY_TEST_FILE"
    rm -f "$ATR_FLAKY_BACKUP"
  elif grep -q 'dd trace auto retry debug flake' "$ATR_FLAKY_TEST_FILE" 2>/dev/null; then
    echo "Temporary Auto Test Retries edit is present, but the backup file is missing." >&2
    exit 1
  fi
fi

rm -f \
  dd-intake-html-file-url.txt \
  dd-intake-html-path.txt \
  dd-intake-log-path.txt \
  dd-intake.pid \
  dd-intake-shutdown-url.txt \
  dd-intake-url.txt \
  dd-test-optimization-agent-adaptations.txt \
  dd-test-optimization-env.txt \
  dd-test-optimization-advanced-validation-url.txt \
  dd-test-optimization-efd-command.txt \
  dd-test-optimization-efd-test-name.txt \
  dd-test-optimization-efd-validation-url.txt \
  dd-test-optimization-efd-new-test-snippet.txt \
  dd-test-optimization-efd-preflight.txt \
  dd-test-optimization-efd-temp-test-file.txt \
  dd-test-optimization-advanced-cleanup.json \
  dd-test-optimization-atr-baseline-command.txt \
  dd-test-optimization-atr-baseline-preflight.txt \
  dd-test-optimization-atr-baseline-snippet.txt \
  dd-test-optimization-atr-generated-test-file.txt \
  dd-test-optimization-selected-command.input \
  dd-test-optimization-selected-files.input \
  dd-test-optimization-atr-flaky-test-backup.txt \
  dd-test-optimization-atr-flaky-test-file.txt \
  dd-test-optimization-atr-flaky-test-name.txt \
  dd-test-optimization-atr-flaky-test-snippet.txt \
  dd-test-optimization-known-tests.json \
  dd-test-optimization-advanced-dry-run.txt \
  dd-test-optimization-tm-attempt-to-fix-command.txt \
  dd-test-optimization-tm-attempt-to-fix-preflight.txt \
  dd-test-optimization-test-management-cleanup.json \
  dd-test-optimization-tm-disabled-command.txt \
  dd-test-optimization-tm-disabled-preflight.txt \
  dd-test-optimization-tm-framework.txt \
  dd-test-optimization-tm-mode.txt \
  dd-test-optimization-tm-quarantined-command.txt \
  dd-test-optimization-tm-quarantined-preflight.txt \
  dd-test-optimization-tm-settings-mode.txt \
  dd-test-optimization-tm-test-command.txt \
  dd-test-optimization-tm-test-file.txt \
  dd-test-optimization-agent-report.json \
  dd-test-optimization-final-report.txt \
  dd-test-optimization-static.json \
  dd-test-optimization-intake.json \
  dd-test-optimization-agent-report.txt \
  dd-test-optimization-selected-test-files.txt \
  dd-test-optimization-test-command.txt \
  dd-test-optimization-test-exit-code.txt \
  dd-test-optimization-test-output.txt \
  dd-test-optimization-test-result.txt \
  dd-test-optimization-validation-url.txt \
  dd-test-optimization-full-validation-url.txt \
  dd-test-optimization-full-advanced-validation-url.txt \
  dd-test-optimization-report.html \
  dd-test-optimization-preexisting-status.txt \
  dd-test-optimization-root-stage.txt \
  dd-test-optimization-summary.txt \
  nohup.out

rm -rf \
  dd-test-optimization-basic \
  dd-test-optimization-efd \
  dd-test-optimization-efd-only \
  dd-test-optimization-atr-only \
  dd-test-optimization-test-management \
  dd-test-optimization-tm-attempt-to-fix \
  dd-test-optimization-tm-attempt-to-fix-baseline \
  dd-test-optimization-tm-disabled \
  dd-test-optimization-tm-disabled-baseline \
  dd-test-optimization-tm-quarantined \
  dd-test-optimization-tm-quarantined-baseline
```

Reruns use stable artifact names by default. Remove stale intermediate artifacts before continuing.
Successful runs intentionally leave diagnostic artifacts in the repository root and
`dd-test-optimization-*` directories until the next Step 0 cleanup. If
`test-optimization-prepare-advanced.js --restore` is used, it removes the helper-created EFD test
file and restores the helper-edited flaky test file; it does not remove diagnostic artifacts.

Generated diagnostic artifacts are safe to keep for the report and safe to remove on the next
runbook execution:

- `dd-test-optimization-*`
- `dd-intake-*`
- `dd-test-optimization-basic/`
- `dd-test-optimization-efd/`

Temporary source edits must be restored before the final response:

- helper-created `dd-trace-efd-debug*.test.*` or `dd-trace-efd-debug*.spec.*` sibling test file
- helper-edited known test file containing `dd trace auto retry debug flake`

Do not remove or modify repository source files except through the explicit temporary-edit restore
steps in Step 0 or Step 7e.

### 1. Check static setup

From this repository root:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/diagnose.js" --json --fail-on=never > dd-test-optimization-static.json
```

Print actionable static findings:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) -e '
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

In Yarn PnP, `portal:`/`link:` dependency, and large-monorepo layouts, the static analyzer may not
resolve `dd-trace` or detect the framework even when both are present and working. Treat
`dd-trace dependency not found`, `No supported test framework detected`, and `No root package.json
found` as likely false positives in these layouts. When static diagnosis and the live intake
disagree, trust the live intake: a `Reporting complete` run with session/module/suite/test events
proves the integration regardless of static warnings. Report such warnings as
`static-analyzer false positive in PnP/portal/monorepo`, not as a missing-dependency finding.

### 2. Choose a test command (wrapper path entry point)

Inspect `package.json`, framework config files, and the static diagnosis output.
Use the actionable static findings printed in Step 1 when Step 1 was run. On the wrapper path, the
wrapper produces the root `dd-test-optimization-static.json` after the selected command is chosen.
This is the only step required before running the Preferred Wrapper.

Run discovery commands:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
const pickDeps = deps => Object.fromEntries(Object.entries(deps || {})
  .filter(([name]) => /^(dd-trace|mocha|jest|vitest|cypress|playwright|@cucumber\/cucumber|cucumber-js)$/.test(name))
)
console.log(JSON.stringify({
  packageManager: p.packageManager,
  scripts: p.scripts || {},
  dependencies: pickDeps(p.dependencies),
  devDependencies: pickDeps(p.devDependencies),
}, null, 2))
'
git status --short

find . \
  \( -path ./node_modules -o -path ./.git -o -path ./vendor \
     -o -name dist -o -name build -o -name coverage \) -prune -o \
  \( -name "*.test.js" -o -name "*.spec.js" -o -name "*.test.ts" -o -name "*.spec.ts" \
     -o -name "*.cy.js" -o -name "*.cy.ts" \) \
  -print | head -20

find . \
  \( -path ./node_modules -o -path ./.git -o -path ./vendor \
     -o -name dist -o -name build -o -name coverage \) -prune -o \
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
- Prefer source test files over generated `dist` test files when both are present.
- Prefer test files that are not listed in `git status --short`; avoid user-modified files when a
  clean equivalent exists.
- Preserve the repository's normal runner command when possible.
- Avoid full suites, watch mode, update snapshots, browser UI mode, or destructive scripts.
- If `scripts.test` already contains runner flags, verify the file argument reaches the runner as intended.
- Never write a bare runner binary command such as `mocha test/sum.spec.js`.

Runner-specific notes:

| Runner | Note |
| --- | --- |
| Jest | Generated multi-file helper commands append `--runInBand` automatically; use `--force-run-in-band` for custom Jest commands that lose suite/test spans. |
| Mocha | Direct file arguments usually work; prefer `npm test -- file` or `./node_modules/.bin/mocha file` over a bare `mocha` binary. |
| Vitest | The wrapper handles the Vitest preload variant; preserve the repository's normal Vitest command and selected file arguments. |
| Cypress | Select one spec through the repository's normal Cypress command or `--spec`; Cypress wiring can differ from Node-only runners. |
| Playwright | Select one spec or grep filter through the repository's normal Playwright command; worker/process propagation can differ from Node-only runners. |

Detect the runner's test-file naming convention before selecting or generating any test file. A
custom `testRegex`/`testMatch`, or a CLI wrapper such as `yarn cli test-unit` instead of a bare
runner, can require a specific suffix such as `.unit.ts`; a generic `.test.js` or `.spec.ts`
sibling may then be silently ignored. Inspect the framework config and one existing passing test
file, and reuse that exact suffix and module style for every temporary file created in Step 7 and
Step 8. Confirm the convention by running the selected command once, without instrumentation, and
checking that it collects and runs tests with a non-zero test count.

Set `SELECTED_TEST_COMMAND` to the selected command, then write it:

Common Yarn + Jest example:

```bash
SELECTED_TEST_COMMAND='yarn test packages/example/src/__tests__/scope.test.ts'
```

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

Validate the selected test files:

Adapt:

```bash
SELECTED_TEST_FILES='FILL_IN' # replace FILL_IN with one test file path per line
# Multiple files example:
# SELECTED_TEST_FILES="$(printf '%s\n' 'test/one.spec.js' 'test path/two.spec.js')"
if [ "$SELECTED_TEST_FILES" = 'FILL_IN' ] || [ -z "$SELECTED_TEST_FILES" ]; then
  echo "Replace FILL_IN with the selected test file paths before continuing."
  exit 1
fi

printf '%s\n' "$SELECTED_TEST_FILES" | sed '/^[[:space:]]*$/d' > dd-test-optimization-selected-test-files.txt
printf 'Selected test command: %s\n' "$(cat dd-test-optimization-test-command.txt)"

while IFS= read -r file; do
  test -f "$file"
done < dd-test-optimization-selected-test-files.txt

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  DIRTY_SELECTED_TESTS=''
  while IFS= read -r file; do
    FILE_STATUS="$(git status --short -- "$file")"
    if [ -n "$FILE_STATUS" ]; then
      printf '%s\n' "$FILE_STATUS"
      DIRTY_SELECTED_TESTS=1
    fi
  done < dd-test-optimization-selected-test-files.txt
  if [ -n "$DIRTY_SELECTED_TESTS" ]; then
    echo "Selected test files have local changes. Choose clean files when possible."
  else
    echo "Selected test files are clean."
  fi
fi
```

If the selected command is uncertain, run it once without Test Optimization instrumentation before
the wrapper. Keep the same command in `dd-test-optimization-test-command.txt` if it selects the
intended subset and exits normally.

## Manual Fallback Path

STOP: do not run this section after a wrapper run reports `Reporting complete`.

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

INTAKE_LOG="$(mktemp "${TMPDIR:-/tmp}/dd-test-optimization-intake.XXXXXX")"
echo "$INTAKE_LOG" > dd-intake-log-path.txt

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-intake.js" \
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
IS_VITEST="$($(cat dd-test-optimization-node-command.txt) -e '
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
DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED=true
DD_CIVISIBILITY_ENABLED=true
DD_CIVISIBILITY_FLAKY_RETRY_ENABLED=true
DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE=false
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false
DD_TEST_MANAGEMENT_ENABLED=true
NODE_OPTIONS=$NODE_OPTIONS_VALUE
EOF

set +e # allow non-zero test exit; capture it manually
DD_API_KEY=debug \
DD_SERVICE=dd-test-optimization-debug \
DD_CIVISIBILITY_AGENTLESS_ENABLED=1 \
DD_CIVISIBILITY_AGENTLESS_URL="$INTAKE_URL" \
DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED=true \
DD_CIVISIBILITY_ENABLED=true \
DD_CIVISIBILITY_FLAKY_RETRY_ENABLED=true \
DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE=false \
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false \
DD_TEST_MANAGEMENT_ENABLED=true \
NODE_OPTIONS="$NODE_OPTIONS_VALUE" \
sh -c "$TEST_COMMAND" > "$TEST_OUTPUT" 2>&1
TEST_EXIT_CODE=$?
cat "$TEST_OUTPUT"
printf '%s\n' "$TEST_EXIT_CODE" > dd-test-optimization-test-exit-code.txt

$(cat dd-test-optimization-node-command.txt) -e '
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

$(cat dd-test-optimization-node-command.txt) -e "fetch(process.argv[1]).then(r => r.text()).then(console.log)" "$SHUTDOWN_URL"
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
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-analyze-intake.js" \
  dd-test-optimization-intake.json \
  --out dd-test-optimization-agent-report.txt \
  --open
```

6b. Run structured analyzer output for decision-tree field names:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-analyze-intake.js" \
  dd-test-optimization-intake.json \
  --json > dd-test-optimization-agent-report.json
```

6c. Render the final report:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-render-report.js" \
  --static dd-test-optimization-static.json \
  --intake dd-test-optimization-intake.json \
  --test-command-file dd-test-optimization-test-command.txt \
  --test-exit-code-file dd-test-optimization-test-exit-code.txt \
  --test-result-file dd-test-optimization-test-result.txt \
  --env-file dd-test-optimization-env.txt \
  --agent-report dd-test-optimization-agent-report.txt \
  --agent-json-report dd-test-optimization-agent-report.json \
  --out dd-test-optimization-final-report.txt \
  --summary-out dd-test-optimization-summary.txt
```

The renderer prints the final report to stdout and also writes `dd-test-optimization-final-report.txt`.
It writes a compact `dd-test-optimization-summary.txt` without the long pako validation paths.

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
Step 9 under the matching stage heading before writing the final response.

The analyzer text report includes the canonical HTML report `file://` URL, absolute HTML report
path, suggested open command, and `Datadog validation:` relative path. Copy those lines exactly into the
final response instead of rewriting them from memory.

## Expected Worktree Changes

Diagnostic artifacts may remain untracked until the next Step 0 cleanup:

- `dd-test-optimization-*`
- `dd-intake-*`
- `dd-test-optimization-basic/`
- `dd-test-optimization-efd/`
- `dd-test-optimization-tm-*/`
- `dd-test-optimization-test-management/`
- `nohup.out` if an agent or shell creates it while running background commands

During Step 7, these temporary source edits may appear:

- helper-created `dd-trace-efd-debug*.test.*` or `dd-trace-efd-debug*.spec.*` sibling test file
- helper-created `dd-trace-atr-debug*` sibling test file, later modified to contain
  `dd trace auto retry debug flake`

During Step 8, these temporary source files may appear:

- helper-created `dd-trace-tm-disabled*.test.*` or `dd-trace-tm-disabled*.spec.*`
- helper-created `dd-trace-tm-quarantined*.test.*` or `dd-trace-tm-quarantined*.spec.*`
- helper-created `dd-trace-tm-attempt-to-fix*.test.*` or `dd-trace-tm-attempt-to-fix*.spec.*`

After Step 7e restore, the temporary EFD test file and temporary Auto Test Retries test file must
be gone. Existing unrelated dirty files in the repository must remain untouched. After each Step 8
restore, the generated Test Management test file and marker file must be gone.

After helper restore, these temporary source-edit state files must be absent:

- `dd-test-optimization-efd-temp-test-file.txt`
- `dd-test-optimization-efd-test-name.txt`
- `dd-test-optimization-atr-generated-test-file.txt`
- `dd-test-optimization-atr-flaky-test-file.txt`
- `dd-test-optimization-atr-flaky-test-backup.txt`
- `dd-test-optimization-atr-flaky-test-name.txt`

These diagnostic artifacts may remain after helper restore:

- `dd-test-optimization-efd-new-test-snippet.txt`
- `dd-test-optimization-atr-baseline-snippet.txt`
- `dd-test-optimization-atr-flaky-test-snippet.txt`
- `dd-test-optimization-basic/`
- `dd-test-optimization-efd/`
- root `dd-test-optimization-*` report, intake, command, output, and summary files
- `dd-test-optimization-tm-*/` subcheck report directories
- `dd-test-optimization-test-management/` response, identity, and snippet files

### 7. Test Early Flake Detection and Auto Test Retries

Run this step after the basic reporting result is `Reporting complete`. If basic reporting is not
complete, do not run advanced feature checks yet; fix the basic reporting funnel first.

The advanced checks require two runs:

- First run: add one generated Auto Test Retries candidate and capture it as a known test with the
  selected subset.
- Second run: serve those known tests, add one new deterministic passing EFD test, make the
  generated Auto Test Retries candidate fail once and then pass, and verify that both EFD and Auto
  Test Retries worked.

Step 7 always runs the wrapper again with `--out-dir`; do not reuse the root wrapper artifact as the
advanced-check baseline. Keeping the advanced baseline in `dd-test-optimization-basic/` prevents
later Step 7 runs from overwriting the root basic-reporting artifacts and gives the known-tests
file, root report, and advanced report distinct provenance for Step 9.

7a. Create a generated Auto Test Retries baseline candidate, run the first baseline in its own
artifact directory, and extract known tests:

Required: use `--out-dir "$BASIC_DIR"` to avoid overwriting root artifacts. It prevents the
baseline advanced-check run from overwriting the root wrapper artifacts used for Step 9.
Use the top-level loopback prerequisite if the wrapper fails with `listen EPERM 127.0.0.1`.
The generated Auto Test Retries candidate is created before this baseline so it becomes a known
test without editing an existing customer test.

For inferred Jest repositories, the helper appends `--runInBand` to generated multi-file commands
automatically. Symptom when a custom command bypasses this: a one-file root run reports complete
session/module/suite/test events, but the multi-file Step 7 command reports only session/module
events or loses suite/test spans. If that happens for explicit helper arguments or a custom command,
rerun the two helper commands below with `--force-run-in-band` and record the adaptation in
`dd-test-optimization-agent-adaptations.txt`.

Verbatim:

```bash
set -e

BASIC_DIR=dd-test-optimization-basic

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" \
  --auto \
  --baseline-candidate \
  --dry-run

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" \
  --auto \
  --baseline-candidate

# If the Jest multi-file command loses suite/test spans, run --restore, then rerun the two helper
# commands above with: --force-run-in-band
# and record:
# printf '%s\n' 'Step 7: used --force-run-in-band because Jest multi-file run lost suite/test spans.' >> dd-test-optimization-agent-adaptations.txt

ATR_BASELINE_COMMAND="$(cat dd-test-optimization-atr-baseline-command.txt)"
set +e
sh -c "$ATR_BASELINE_COMMAND" > dd-test-optimization-atr-baseline-preflight.txt 2>&1
ATR_BASELINE_PREFLIGHT_EXIT_CODE=$?
cat dd-test-optimization-atr-baseline-preflight.txt
set -e
if [ "$ATR_BASELINE_PREFLIGHT_EXIT_CODE" -ne 0 ]; then
  echo "Auto Test Retries baseline preflight failed. Fix the generated candidate suffix, location, or template before the wrapper baseline." >&2
  exit "$ATR_BASELINE_PREFLIGHT_EXIT_CODE"
fi

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
function read (file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (_) {
    return ""
  }
}
function getCount (text) {
  const jest = text.match(/Tests:\s+.*?(\d+)\s+total/)
  if (jest) return Number(jest[1])
  const vitest = text.match(/\bTests\s+.*?\((\d+)\)/)
  if (vitest) return Number(vitest[1])
  const mochaPassing = text.match(/(\d+)\s+passing/)
  const mochaFailing = text.match(/(\d+)\s+failing/)
  if (mochaPassing || mochaFailing) {
    return Number(mochaPassing?.[1] || 0) + Number(mochaFailing?.[1] || 0)
  }
}
const baselineCount = getCount(read("dd-test-optimization-test-output.txt"))
const preflightCount = getCount(read("dd-test-optimization-atr-baseline-preflight.txt"))
if (baselineCount !== undefined && preflightCount !== undefined && preflightCount <= baselineCount) {
  console.error(`Auto Test Retries baseline preflight did not increase the observed test count (${baselineCount} -> ${preflightCount}).`)
  console.error("Fix the generated ATR candidate suffix/location before the wrapper baseline.")
  process.exit(1)
}
if (baselineCount !== undefined && preflightCount !== undefined) {
  console.log(`Auto Test Retries baseline preflight test count increased: ${baselineCount} -> ${preflightCount}`)
} else {
  console.log("Auto Test Retries baseline preflight test count comparison unavailable; continuing after successful command exit.")
}
'

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-atr-baseline-command.txt \
  --out-dir "$BASIC_DIR" \
  --no-open

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-analyze-intake.js" \
  "$BASIC_DIR/dd-test-optimization-intake.json" \
  --json \
  --known-tests-out dd-test-optimization-known-tests.json \
  > "$BASIC_DIR/dd-test-optimization-agent-report.json"

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-basic/dd-test-optimization-agent-report.json", "utf8"))
if (report.primaryStage !== "Reporting complete") {
  console.error(`First advanced-check baseline run must be Reporting complete, got: ${report.primaryStage}`)
  process.exit(1)
}
const knownTests = JSON.parse(fs.readFileSync("dd-test-optimization-known-tests.json", "utf8"))
console.log(JSON.stringify(knownTests, null, 2))
'
```

Prepare common Jest, Mocha, and Vitest layouts automatically:

The dry run prints the inferred files and command without writing files. Run it before the helper
that modifies source:

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" --auto --dry-run
```

The next command intentionally modifies repository source temporarily:

- creates one sibling EFD test file
- modifies the generated Auto Test Retries candidate so its first execution fails and its retry
  passes
- records enough state for `test-optimization-prepare-advanced.js --restore` to undo both changes

The default auto path does not edit an existing customer test file. If generated candidate setup
cannot work for this repository, use the explicit helper form or manual Step 7b/7c fallback and
prefer a generated file over an existing customer test. The helper still refuses to edit a dirty or
untracked existing known test file when explicit fallback arguments target one.

The `--auto` helper can exit 0 and still produce a broken edit: it may create a temporary test file
whose suffix does not match the runner's test pattern, or fail to handle a source shape it inferred
too optimistically. Do not trust the exit code alone. The Step 7d pre-flight verifies that the edit
compiles and is collected. If it fails, run `--restore`, then redo manually: place
`let ddTraceAutoRetryCounter = 0` after the final import line in the generated ATR candidate, put
the one-time `throw` inside that test body, and give generated files the runner's required suffix.

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" --auto
```

7b. Add one new deterministic passing test that is not present in
`dd-test-optimization-known-tests.json`.

For common Jest, Mocha, or Vitest files with simple `test(...)` or `it(...)` callback tests, use
`test-optimization-prepare-advanced.js --auto`; it prepares Step 7b and Step 7c together. The
helper reads `dd-test-optimization-known-tests.json`,
`dd-test-optimization-atr-generated-test-file.txt`, and
`dd-test-optimization-atr-baseline-command.txt`, creates a temporary sibling EFD test, makes the
generated ATR candidate fail once, and writes `dd-test-optimization-efd-command.txt`.
If `--auto` succeeds, skip the manual Step 7b and Step 7c edit instructions and continue to Step
7d. If `--auto` cannot infer a safe edit, use the explicit helper form or the manual Step 7b and
Step 7c instructions below.

The helper accepts the literal source-level test name from `test("name", ...)` or `it("name", ...)`;
it also accepts a suite-qualified analyzer name when exactly one source-level test name matches the
end. If the helper cannot match the known test, retry with the literal source-level name, then
continue with the manual Step 7b and Step 7c instructions if needed.

Adapt:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" \
  --framework jest \
  --efd-test-file FILL_IN_TEMP_TEST_FILE \
  --flaky-test-file FILL_IN_KNOWN_TEST_FILE \
  --flaky-test-name "FILL_IN_KNOWN_TEST_NAME" \
  --efd-command "FILL_IN_SECOND_TEST_COMMAND"
```

Replace `FILL_IN_TEMP_TEST_FILE`, `FILL_IN_KNOWN_TEST_FILE`, `FILL_IN_KNOWN_TEST_NAME`, and
`FILL_IN_SECOND_TEST_COMMAND` before running. For source-safe fallback, set
`FILL_IN_KNOWN_TEST_FILE` to a generated ATR candidate that was included in the baseline run, not
an existing customer test. For `FILL_IN_KNOWN_TEST_NAME`, prefer the exact known-test name from
`dd-test-optimization-known-tests.json`; use the literal source-level test name if the helper
reports that it cannot match the suite-qualified name. Use `--framework mocha` or
`--framework vitest` when that matches the selected command. The helper writes:

- `dd-test-optimization-efd-temp-test-file.txt`
- `dd-test-optimization-efd-test-name.txt`
- `dd-test-optimization-efd-new-test-snippet.txt`
- `dd-test-optimization-atr-generated-test-file.txt` when the source-safe generated ATR path is used
- `dd-test-optimization-atr-flaky-test-file.txt`
- `dd-test-optimization-atr-flaky-test-backup.txt`
- `dd-test-optimization-atr-flaky-test-name.txt`
- `dd-test-optimization-atr-flaky-test-snippet.txt`
- `dd-test-optimization-atr-baseline-command.txt` during the source-safe generated ATR baseline
- `dd-test-optimization-efd-command.txt`

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
- Remove `test/dd-trace-efd-debug.spec.js` after Step 7e passes.

Yarn example:

- If the first command is `yarn test test/sum.spec.js`, create `test/dd-trace-efd-debug.spec.js`.
- Use `yarn test test/sum.spec.js test/dd-trace-efd-debug.spec.js` for the second EFD command.
- Remove `test/dd-trace-efd-debug.spec.js` after Step 7e passes.

Temporary test templates:

Match the selected test file's framework and module style. For TypeScript test files, prefer a
TypeScript/global-runner style template over CommonJS `require`.

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

Jest TypeScript:

```ts
describe('dd trace EFD debug', () => {
  test('dd trace EFD debug temporary test', () => {
    expect(1 + 1).toBe(2)
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

After creating a temporary sibling test file, write and verify its path. The
`dd-test-optimization-efd-temp-test-file.txt` marker is required for Step 0 to remove the file
during cleanup after an interrupted manual run:

Adapt:

```bash
EFD_TEMP_TEST_FILE='FILL_IN' # replace FILL_IN with the temporary test file path, for example: test/dd-trace-efd-debug.spec.js
EFD_TEST_NAME='dd trace EFD debug temporary test' # replace if the temporary test uses a different name
if [ "$EFD_TEMP_TEST_FILE" = 'FILL_IN' ] || [ -z "$EFD_TEMP_TEST_FILE" ]; then
  echo "Replace FILL_IN with the temporary EFD test file path before continuing."
  exit 1
fi
if [ -z "$EFD_TEST_NAME" ]; then
  echo "Set EFD_TEST_NAME to the temporary test name before continuing."
  exit 1
fi
test -f "$EFD_TEMP_TEST_FILE"
printf 'Temporary EFD test file: %s\n' "$EFD_TEMP_TEST_FILE"
printf '%s\n' "$EFD_TEMP_TEST_FILE" > dd-test-optimization-efd-temp-test-file.txt
printf '%s\n' "$EFD_TEST_NAME" > dd-test-optimization-efd-test-name.txt
cat "$EFD_TEMP_TEST_FILE" > dd-test-optimization-efd-new-test-snippet.txt
```

If the runner required appending a temporary test case to an existing file instead of creating a
temporary sibling file, record the cleanup command in the final response and verify cleanup with a
repository-specific command after Step 7e. Also write only the temporary test snippet to
`dd-test-optimization-efd-new-test-snippet.txt` before Step 7d.

7c. Make the generated Auto Test Retries candidate flaky.

Adapt:

- Prefer the generated ATR candidate recorded in
  `dd-test-optimization-atr-generated-test-file.txt`; it was included in the first baseline run, so
  it is known without modifying customer tests.
- Change that generated test so the first execution throws and the retry passes.
- Write only the temporary flaky edit snippet to
  `dd-test-optimization-atr-flaky-test-snippet.txt`.

Temporary flaky edit pattern:

```js
let ddTraceAutoRetryCounter = 0

it('already known test', () => {
  if (ddTraceAutoRetryCounter++ === 0) throw new Error('dd trace auto retry debug flake')
})
```

The real edit must preserve the existing known test name. Add the counter near the test in the
same generated file and keep or restore any original assertions after the one-time failure branch.

Record the generated ATR file before editing. The `dd-test-optimization-atr-flaky-test-file.txt`
and `dd-test-optimization-atr-generated-test-file.txt` markers are required for Step 0 to remove
the generated file during cleanup after an interrupted manual run:

Adapt:

```bash
ATR_FLAKY_TEST_FILE="$(cat dd-test-optimization-atr-generated-test-file.txt)"
if [ "$ATR_FLAKY_TEST_FILE" = 'FILL_IN' ] || [ -z "$ATR_FLAKY_TEST_FILE" ]; then
  echo "Replace FILL_IN with the generated ATR test file before continuing."
  exit 1
fi
test -f "$ATR_FLAKY_TEST_FILE"
printf '%s\n' "$ATR_FLAKY_TEST_FILE" > dd-test-optimization-atr-flaky-test-file.txt
printf '%s\n' 'FILL_IN_KNOWN_TEST_NAME' > dd-test-optimization-atr-flaky-test-name.txt
if grep -q 'FILL_IN' dd-test-optimization-atr-flaky-test-name.txt; then
  echo "Replace FILL_IN_KNOWN_TEST_NAME with the known test name before continuing." >&2
  exit 1
fi
printf 'Auto Test Retries flaky test file: %s\n' "$ATR_FLAKY_TEST_FILE"
```

Only if a generated ATR candidate cannot be collected should an agent edit an existing clean known
test. In that fallback, save a backup under `dd-test-optimization-efd/backups/`, write
`dd-test-optimization-atr-flaky-test-backup.txt`, and restore it in Step 7e.

After editing, write the exact temporary snippet that was added or changed:

Adapt:

```bash
cat > dd-test-optimization-atr-flaky-test-snippet.txt <<'EOF'
FILL_IN exact temporary flaky edit snippet
EOF
if grep -q 'FILL_IN' dd-test-optimization-atr-flaky-test-snippet.txt; then
  echo "Replace FILL_IN with the exact temporary flaky edit snippet before continuing."
  exit 1
fi
```

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

Pre-flight before the instrumented advanced run. After preparation, either `--auto` or the manual
Step 7b/7c edits, confirm the edits compile and are collected before spending a full wrapper run.

Verbatim:

```bash
set +e

EFD_COMMAND="$(cat dd-test-optimization-efd-command.txt)"
sh -c "$EFD_COMMAND" > dd-test-optimization-efd-preflight.txt 2>&1
EFD_PREFLIGHT_EXIT_CODE=$?
cat dd-test-optimization-efd-preflight.txt

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
function read (file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (_) {
    return ""
  }
}
function getCount (text) {
  const jest = text.match(/Tests:\s+.*?(\d+)\s+total/)
  if (jest) return Number(jest[1])
  const vitest = text.match(/\bTests\s+.*?\((\d+)\)/)
  if (vitest) return Number(vitest[1])
  const mochaPassing = text.match(/(\d+)\s+passing/)
  const mochaFailing = text.match(/(\d+)\s+failing/)
  if (mochaPassing || mochaFailing) {
    return Number(mochaPassing?.[1] || 0) + Number(mochaFailing?.[1] || 0)
  }
}
const baselineCount = getCount(read("dd-test-optimization-test-output.txt"))
const preflightCount = getCount(read("dd-test-optimization-efd-preflight.txt"))
if (baselineCount !== undefined && preflightCount !== undefined && preflightCount <= baselineCount) {
  console.error(`Pre-flight: advanced command did not increase the observed test count (${baselineCount} -> ${preflightCount}).`)
  console.error("Fix the temporary test file suffix/location to match the runner before Step 7d.")
  process.exit(1)
}
if (baselineCount !== undefined && preflightCount !== undefined) {
  console.log(`Pre-flight test count increased: ${baselineCount} -> ${preflightCount}`)
} else {
  console.log("Pre-flight test count comparison unavailable; continuing with flaky-marker checks.")
}
'
EFD_PREFLIGHT_COUNT_STATUS=$?
if [ "$EFD_PREFLIGHT_COUNT_STATUS" -ne 0 ]; then
  exit "$EFD_PREFLIGHT_COUNT_STATUS"
fi

if ! grep -q 'dd trace auto retry debug flake' dd-test-optimization-efd-preflight.txt; then
  echo "Pre-flight: flaky known test did not fail; the temporary flaky edit may be misplaced" >&2
  echo "(for example inserted inside an import block). Confirm it before Step 7d." >&2
  tail -20 dd-test-optimization-efd-preflight.txt >&2
  exit 1
fi

if [ "$EFD_PREFLIGHT_EXIT_CODE" -eq 0 ]; then
  echo "Pre-flight: command exited 0 even though the flaky known test should fail once." >&2
  exit 1
fi

echo "Pre-flight ok: temporary EFD test collected and flaky known test failed once."
```

7d. Run the second advanced run with known tests from the first run:

Required: use `--out-dir "$EFD_DIR"` to avoid overwriting root artifacts. It prevents the second
advanced run from overwriting the root wrapper artifacts and the first baseline artifacts.
Use the top-level loopback prerequisite if the wrapper fails with `listen EPERM 127.0.0.1`.

Verbatim:

```bash
set -e

EFD_DIR=dd-test-optimization-efd

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-efd-command.txt \
  --settings-mode debug-all \
  --known-tests dd-test-optimization-known-tests.json \
  --new-test-snippet-file dd-test-optimization-efd-new-test-snippet.txt \
  --flaky-test-snippet-file dd-test-optimization-atr-flaky-test-snippet.txt \
  --out-dir "$EFD_DIR" \
  --no-open
```

The debug-all fake settings endpoint returns EFD and Auto Test Retries settings:

```json
{
  "early_flake_detection": {
    "enabled": true,
    "slow_test_retries": {
      "5s": 3
    }
  },
  "flaky_test_retries_enabled": true,
  "flaky_test_retries_count": 1,
  "known_tests_enabled": true
}
```

Frameworks can report test names with nested suite or `describe` text already included. Repeated
words in EFD retried new test names are not automatically malformed; compare them with the
temporary EFD suite and test names before treating them as a diagnostic failure.

If the combined `debug-all` validation fails, the validation-and-restore block below restores the
temporary edits before exiting. To isolate the failure, repeat Step 7b/7c preparation and rerun one
isolated advanced check at a time before concluding that a feature is broken:

- EFD-only: rerun the second command with `--settings-mode efd`, the known-tests file, and the
  new-test snippet file.
- Auto Test Retries-only: rerun the second command with `--settings-mode atr`, the known-tests file,
  and the flaky-test snippet file.

Use separate output directories so isolated runs do not overwrite root or combined artifacts. If an
isolated run passes, report the combined-run failure as test setup interference rather than a
feature failure.

EFD-only fallback, used instead of the combined Step 7d command after Step 7b/7c preparation:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-efd-command.txt \
  --settings-mode efd \
  --known-tests dd-test-optimization-known-tests.json \
  --new-test-snippet-file dd-test-optimization-efd-new-test-snippet.txt \
  --out-dir dd-test-optimization-efd-only \
  --no-open
```

Auto Test Retries-only fallback, used instead of the combined Step 7d command after Step 7b/7c
preparation:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command-file dd-test-optimization-efd-command.txt \
  --settings-mode atr \
  --known-tests dd-test-optimization-known-tests.json \
  --flaky-test-snippet-file dd-test-optimization-atr-flaky-test-snippet.txt \
  --out-dir dd-test-optimization-atr-only \
  --no-open
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

7e. Validate the advanced result:

Verbatim:

```bash
set +e

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-efd/dd-test-optimization-agent-report.json", "utf8"))
function readOptional (file) {
  try {
    return fs.readFileSync(file, "utf8").trim()
  } catch (_) {
    return ""
  }
}
function hasExpectedName (names, expected) {
  if (!expected) return true
  return names.some(name => name === expected || name.endsWith(` ${expected}`) || name.includes(expected))
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
  console.error(`No new test was retried by EFD. ${report.summary.efd.execution?.diagnosis || ""}`.trim())
  process.exit(1)
}
const expectedEfdName = readOptional("dd-test-optimization-efd-test-name.txt")
if (!hasExpectedName(report.summary.efd.retriedNewTestNames, expectedEfdName)) {
  console.error(`The retried EFD test names did not include the expected temporary test: ${expectedEfdName}`)
  process.exit(1)
}
if (!report.summary.atr.settingsEnabled) {
  console.error("Auto Test Retries settings were not enabled in the second run.")
  process.exit(1)
}
if (report.summary.atr.failedExecutions === 0) {
  console.error("No failing execution was reported for the flaky known test.")
  process.exit(1)
}
if (report.summary.atr.passedExecutions === 0) {
  console.error("No passing execution was reported for the flaky known test.")
  process.exit(1)
}
if (report.summary.atr.passedRetryTests === 0) {
  console.error("No passing execution was marked with test.is_retry=true and auto_test_retry.")
  process.exit(1)
}
if (report.summary.atr.failedThenPassedRetryTests === 0) {
  console.error("No known flaky test reported both a failure and a passing retry.")
  process.exit(1)
}
const expectedAtrName = readOptional("dd-test-optimization-atr-flaky-test-name.txt")
if (!hasExpectedName(report.summary.atr.failedThenPassedRetryTestNames, expectedAtrName)) {
  console.error(`The Auto Test Retries flaky test names did not include the expected known test: ${expectedAtrName}`)
  process.exit(1)
}
console.log(`EFD retried new tests: ${report.summary.efd.retriedNewTests}`)
console.log(`EFD execution diagnosis: ${report.summary.efd.execution?.diagnosis || "n/a"}`)
console.log(`Retried new test names: ${report.summary.efd.retriedNewTestNames.join(", ")}`)
console.log(`Auto Test Retries flaky tests reported: ${report.summary.atr.failedThenPassedRetryTests}`)
console.log(`Auto Test Retries flaky test names: ${report.summary.atr.failedThenPassedRetryTestNames.join(", ")}`)
'
ADVANCED_VALIDATION_STATUS=$?

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-advanced.js" --restore
ADVANCED_RESTORE_STATUS=$?

git status --short

if [ "$ADVANCED_RESTORE_STATUS" -ne 0 ]; then
  echo "Advanced validation finished, but temporary edit restore failed." >&2
  exit "$ADVANCED_RESTORE_STATUS"
fi

if [ "$ADVANCED_VALIDATION_STATUS" -ne 0 ]; then
  echo "Advanced validation failed after temporary edits were restored." >&2
  exit "$ADVANCED_VALIDATION_STATUS"
fi
```

If this validation-and-restore block passes, report that EFD and Auto Test Retries work for the
selected subset. When reporting EFD retried new test names, note that frameworks often prepend the
suite or `describe` text to the test name, so a value like
`dd trace EFD debug dd trace EFD debug temporary test` is the expected suite-plus-test
concatenation, not a malformed name. The restore command removes the helper-created EFD test file
and removes the generated Auto Test Retries test file even when validation fails. After helper restore
succeeds, the manual cleanup blocks below should be no-ops. Run them only to verify no recorded
temporary state remains, or when Step 7b/7c used manual edits instead of the helper.

Remove and verify a temporary sibling test file. Remove the file recorded in
`dd-test-optimization-efd-temp-test-file.txt`.

Verbatim:

```bash
if [ -f dd-test-optimization-efd-temp-test-file.txt ]; then
  EFD_TEMP_TEST_FILE="$(cat dd-test-optimization-efd-temp-test-file.txt)"
  rm -f "$EFD_TEMP_TEST_FILE"
  test ! -e "$EFD_TEMP_TEST_FILE"
  if git status --short -- "$EFD_TEMP_TEST_FILE" | grep .; then
    echo "Temporary EFD test file still appears in git status." >&2
    exit 1
  fi
  printf 'Temporary EFD test removed: %s\n' "$EFD_TEMP_TEST_FILE"
  rm -f dd-test-optimization-efd-temp-test-file.txt dd-test-optimization-efd-test-name.txt
fi
```

If the EFD test was appended to an existing file, remove only the temporary test case and run the
repository-specific cleanup verification recorded in Step 7b.

Remove and verify the generated Auto Test Retries test file. If explicit manual fallback edited an
existing known test instead, restore it from `dd-test-optimization-atr-flaky-test-backup.txt`.

Verbatim:

```bash
if [ -f dd-test-optimization-atr-generated-test-file.txt ]; then
  ATR_GENERATED_TEST_FILE="$(cat dd-test-optimization-atr-generated-test-file.txt)"
  rm -f "$ATR_GENERATED_TEST_FILE"
  test ! -e "$ATR_GENERATED_TEST_FILE"
  if git status --short -- "$ATR_GENERATED_TEST_FILE" | grep .; then
    echo "Temporary Auto Test Retries generated test file still appears in git status." >&2
    exit 1
  fi
  printf 'Temporary Auto Test Retries generated test removed: %s\n' "$ATR_GENERATED_TEST_FILE"
  rm -f \
    dd-test-optimization-atr-generated-test-file.txt \
    dd-test-optimization-atr-flaky-test-file.txt \
    dd-test-optimization-atr-flaky-test-name.txt
elif [ -f dd-test-optimization-atr-flaky-test-file.txt ]; then
  ATR_FLAKY_TEST_FILE="$(cat dd-test-optimization-atr-flaky-test-file.txt)"
  ATR_FLAKY_BACKUP="$(cat dd-test-optimization-atr-flaky-test-backup.txt)"
  cp "$ATR_FLAKY_BACKUP" "$ATR_FLAKY_TEST_FILE"
  rm -f "$ATR_FLAKY_BACKUP"
  if grep -q 'dd trace auto retry debug flake' "$ATR_FLAKY_TEST_FILE"; then
    echo "Temporary Auto Test Retries flaky edit is still present." >&2
    exit 1
  fi
  git diff --exit-code -- "$ATR_FLAKY_TEST_FILE"
  printf 'Temporary Auto Test Retries edit restored: %s\n' "$ATR_FLAKY_TEST_FILE"
  rm -f \
    dd-test-optimization-atr-flaky-test-file.txt \
    dd-test-optimization-atr-flaky-test-backup.txt \
    dd-test-optimization-atr-flaky-test-name.txt
fi

git status --short
```

### 8. Test Test Management

Run this step after the basic reporting result is `Reporting complete`. Test Management is three
independent subchecks. Do not combine them unless every result can be attributed to one calibrated
test identity. This is the slowest section of the runbook because each subcheck does a baseline
calibration run and a managed run. In a time-boxed diagnosis, Step 8 is the first optional section
to defer after basic reporting, EFD, and Auto Test Retries are already understood.

Subcheck map:

| Subcheck | Helper mode | Wrapper settings mode | Expected selected test behavior |
| --- | --- | --- | --- |
| Disabled | `disabled` | `tm-disabled` | test would fail if executed; command exit code recorded by wrapper must be `0` |
| Quarantined | `quarantined` | `tm-quarantined` | test runs and reports a failed span; command exit code recorded by wrapper must be `0` |
| Attempt-to-fix | `attempt-to-fix` | `tm-attempt-to-fix` | first execution passes, retry fails with `test.retry_reason=attempt_to_fix`; command exit code recorded by wrapper must be non-zero |

The `tm-disabled`, `tm-quarantined`, and `tm-attempt-to-fix` settings modes keep EFD and Auto Test
Retries disabled. Use `tm-attempt-to-fix-priority` only for an optional interaction check after the
base attempt-to-fix subcheck passes.

For each subcheck:

1. Generate one temporary test file in a selected test directory.
2. Run a baseline command with `DD_TEST_OPTIMIZATION_TM_BASELINE=1` so the generated simple test
   passes and the intake captures its framework, suite, and name.
3. Build the Test Management properties response from the baseline artifact.
4. Run the generated test again with the matching `tm-*` settings mode and the calibrated response.
5. Restore generated source and marker files before moving to the next subcheck.

8a. Infer one subcheck plan.

Run Step 8a and Step 8b once for each `TM_MODE`: `disabled`, `quarantined`, and
`attempt-to-fix`. The helper reads `dd-test-optimization-test-command.txt` and
`dd-test-optimization-selected-test-files.txt` to create a generated sibling test path. If
`dd-test-optimization-known-tests.json` exists, the helper prefers its framework and suite identity;
otherwise Step 8 remains independent from Step 7. The helper writes the state files consumed by
Step 8b.

Adapt only `TM_MODE`:

```bash
TM_MODE='disabled' # disabled, quarantined, or attempt-to-fix

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" \
  --auto \
  --mode "$TM_MODE" \
  --dry-run

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" \
  --auto \
  --mode "$TM_MODE"
```

For inferred Jest repositories, the helper appends `--runInBand` to generated multi-file commands
automatically. If an explicit custom Test Management command still loses suite/test spans when it
includes multiple files, rerun Step 8a with `--force-run-in-band` on both helper commands and
record:

```bash
printf '%s\n' "Step 8 ${TM_MODE}: used --force-run-in-band because Jest multi-file run lost suite/test spans." >> dd-test-optimization-agent-adaptations.txt
```

Fallback command selection rules when auto inference cannot pick a safe generated-test command:

- Prefer a generated sibling test file under the same directory as the selected basic-reporting test.
- Prefer `npm test -- "$TM_TEST_FILE"` when `scripts.test` is a direct runner command that accepts
  file arguments.
- Use `./node_modules/.bin/<runner> "$TM_TEST_FILE"` when `scripts.test` is absent or cannot accept
  a direct file argument.
- Do not edit an existing customer test for these subchecks unless generated tests cannot work.
- The generated helper supports Jest, Mocha, Vitest, and Cypress-style globals/imports. For
  Playwright or another unsupported generated-test shape, skip Step 8 with the reason printed by
  the helper or write a repository-specific temporary candidate manually.
- Ensure the generated `TM_TEST_FILE` uses the suffix the runner actually collects; use the naming
  detection in Step 2. A non-matching extension such as `.ts` where the runner requires `.unit.ts`
  is silently not collected: the baseline run reports zero test events and the calibrated identity
  cannot be built. After `--create`, run the Test Management command once without instrumentation
  and confirm the generated candidate is collected before the baseline-calibration wrapper run.

8b. Create, baseline-calibrate, run, validate, and restore one subcheck.

Verbatim:

```bash
set -e

TM_MODE="$(cat dd-test-optimization-tm-mode.txt)"
TM_SETTINGS_MODE="$(cat dd-test-optimization-tm-settings-mode.txt)"
TM_FRAMEWORK="$(cat dd-test-optimization-tm-framework.txt)"
TM_TEST_FILE="$(cat dd-test-optimization-tm-test-file.txt)"
TM_TEST_COMMAND="$(cat dd-test-optimization-tm-test-command.txt)"

cleanup_tm () {
  $(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" --restore >/dev/null 2>&1 || true
}
trap cleanup_tm EXIT

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" \
  --create \
  --mode "$TM_MODE" \
  --framework "$TM_FRAMEWORK" \
  --test-file "$TM_TEST_FILE"

TM_BASELINE_DIR="dd-test-optimization-tm-${TM_MODE}-baseline"
TM_RESULT_DIR="dd-test-optimization-tm-${TM_MODE}"
TM_BASELINE_COMMAND="DD_TEST_OPTIMIZATION_TM_BASELINE=1 $TM_TEST_COMMAND"

set +e
DD_TEST_OPTIMIZATION_TM_BASELINE=1 sh -c "$TM_TEST_COMMAND" > "dd-test-optimization-tm-${TM_MODE}-preflight.txt" 2>&1
TM_PREFLIGHT_EXIT_CODE=$?
cat "dd-test-optimization-tm-${TM_MODE}-preflight.txt"
set -e

if [ "$TM_PREFLIGHT_EXIT_CODE" -ne 0 ]; then
  echo "Test Management preflight failed before instrumentation; fix the generated candidate." >&2
  exit "$TM_PREFLIGHT_EXIT_CODE"
fi

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")
const mode = process.argv[1]
function read (file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (_) {
    return ""
  }
}
function getCount (text) {
  const jest = text.match(/Tests:\s+.*?(\d+)\s+total/)
  if (jest) return Number(jest[1])
  const vitest = text.match(/\bTests\s+.*?\((\d+)\)/)
  if (vitest) return Number(vitest[1])
  const mochaPassing = text.match(/(\d+)\s+passing/)
  const mochaFailing = text.match(/(\d+)\s+failing/)
  if (mochaPassing || mochaFailing) {
    return Number(mochaPassing?.[1] || 0) + Number(mochaFailing?.[1] || 0)
  }
}
const baselineCount = getCount(read("dd-test-optimization-test-output.txt"))
const preflightCount = getCount(read(`dd-test-optimization-tm-${mode}-preflight.txt`))
if (baselineCount !== undefined && preflightCount !== undefined && preflightCount <= baselineCount) {
  console.error(`Test Management preflight did not increase the observed test count (${baselineCount} -> ${preflightCount}).`)
  console.error("Fix the generated TM test suffix/location before the baseline-calibration wrapper run.")
  process.exit(1)
}
if (baselineCount !== undefined && preflightCount !== undefined) {
  console.log(`Test Management preflight test count increased: ${baselineCount} -> ${preflightCount}`)
} else {
  console.log("Test Management preflight test count comparison unavailable; continuing after successful command exit.")
}
' "$TM_MODE"

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command "$TM_BASELINE_COMMAND" \
  --settings-mode basic-reporting \
  --out-dir "$TM_BASELINE_DIR" \
  --no-open

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" \
  --response \
  --mode "$TM_MODE" \
  --baseline-intake "$TM_BASELINE_DIR/dd-test-optimization-intake.json" \
  --out "$TM_RESULT_DIR/test-management-tests.json" \
  --identity-out "$TM_RESULT_DIR/test-management-identity.json"

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-debug.js" \
  --test-command "$TM_TEST_COMMAND" \
  --settings-mode "$TM_SETTINGS_MODE" \
  --test-management-tests "$TM_RESULT_DIR/test-management-tests.json" \
  --out-dir "$TM_RESULT_DIR" \
  --no-open

export TM_MODE

$(cat dd-test-optimization-node-command.txt) -e '
const fs = require("node:fs")

const mode = process.env.TM_MODE
const dir = `dd-test-optimization-tm-${mode}`
const report = JSON.parse(fs.readFileSync(`${dir}/dd-test-optimization-agent-report.json`, "utf8"))
const exitCode = fs.readFileSync(`${dir}/dd-test-optimization-test-exit-code.txt`, "utf8").trim()
const tm = report.summary.tm
const expected = mode === "attempt-to-fix" ? "attemptToFix" : mode
const subcheck = tm[expected]

function fail (message) {
  console.error(message)
  process.exit(1)
}

if (!tm.settingsEnabled) fail("Test Management settings were not enabled.")
if (!tm.propertiesEndpointCalled) fail("Test Management properties endpoint was not called.")
if (tm.returnedProperties === 0) fail("Test Management properties response was empty.")
if (tm.unmatchedPropertyIdentities.length > 0) {
  fail(`Test Management properties did not match emitted identities: ${tm.unmatchedPropertyIdentities.join(", ")}`)
}
if (!subcheck || subcheck.status !== "passed") {
  fail(`Test Management ${mode} subcheck failed: ${subcheck?.reason || "missing subcheck"}`)
}
if ((mode === "disabled" || mode === "quarantined") && exitCode !== "0") {
  fail(`Expected ${mode} command exit code 0, got ${exitCode}.`)
}
if (mode === "attempt-to-fix" && exitCode === "0") {
  fail("Expected attempt-to-fix command exit code to be non-zero.")
}
if (mode === "attempt-to-fix" && subcheck.badRetryReasons.length > 0) {
  fail(`Attempt-to-fix used unexpected retry reasons: ${subcheck.badRetryReasons.join(", ")}`)
}

console.log(`Test Management ${mode}: passed`)
console.log(`Managed identities: ${subcheck.identities.join(", ") || "none"}`)
console.log(`Observed statuses: ${subcheck.observedStatuses.join(", ") || "none"}`)
console.log(`Observed final statuses: ${subcheck.observedFinalStatuses.join(", ") || "none"}`)
console.log(`Observed retry reasons: ${subcheck.observedRetryReasons.join(", ") || "none"}`)
console.log(`Command exit code: ${exitCode}`)
'

$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" --restore
trap - EXIT
```

Do not hand-write the Test Management identity. For generated simple candidates, the helper reads
the framework, suite, and test name from the baseline intake artifact and writes the response
expected by `/api/v2/test/libraries/test-management/tests`. This does not claim general exact
identity coverage for parameterized customer tests, test parameters, or custom module dimensions
unless the generated response is rebuilt from that exact baseline artifact and the managed run
matches it.

If baseline calibration, the managed run, or validation fails, the `EXIT` trap still runs the helper
restore. After any failure, run the restore command again and report whether cleanup succeeded:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-prepare-test-management.js" --restore
git status --short
```

Repeat Step 8a-8b for `disabled`, `quarantined`, and `attempt-to-fix`. The three result directories
must be:

- `dd-test-optimization-tm-disabled/`
- `dd-test-optimization-tm-quarantined/`
- `dd-test-optimization-tm-attempt-to-fix/`

Optional priority interaction check:

- Reuse the attempt-to-fix candidate flow.
- Use `TM_SETTINGS_MODE='tm-attempt-to-fix-priority'`.
- Use a separate result directory if running manually.
- Verify retry reasons remain exactly `attempt_to_fix`, not `auto_test_retry` or
  `early_flake_detection`.

### 9. Report back

If the wrapper path was used, read the root `dd-test-optimization-summary.txt` first for the basic
reporting result and use the Step 9 extractor for the combined validation path and artifact paths.
The root compact summary describes only the root/basic wrapper run. After Step
7, advanced EFD and Auto Test Retries status must come from the Step 9 extractor or
`dd-test-optimization-efd/dd-test-optimization-final-report.txt`, not from the root compact
summary. If manual Steps 3-6 were used, include the Step 6c stdout report or the compact summary,
then run the Step 9 extractor for the combined validation path. Do not `cat`
`dd-test-optimization-final-report.txt` after Step 6c; that duplicates the same report. Add notable
weird cases not represented in the generated report only when needed.

Report static warnings and errors from the initial root `dd-test-optimization-static.json`. If the
wrapper is run without Step 1, use the wrapper-generated root `dd-test-optimization-static.json`.
Do not switch to `dd-test-optimization-basic/dd-test-optimization-static.json` or
`dd-test-optimization-efd/dd-test-optimization-static.json` unless the difference is the notable
case being reported.

Apply the Step 1 static false-positive guidance when live intake succeeds in a Yarn PnP,
`portal:`, `link:`, or monorepo layout.

Use this extractor to assemble the required fields from the root, advanced-check, and Test
Management artifacts. It prints one combined `Datadog validation:` path for the whole runbook
execution.

The `--strict-test-management` flag requires all three Test Management subchecks to be present in
the combined result: disabled, quarantined, and attempt-to-fix. If strict validation fails, inspect
the Test Management subcheck reasons in the final reports and any `unmatchedPropertyIdentities`
evidence before rerunning. Treat missing subchecks or identity mismatches as setup/artifact issues
until the individual Step 8 result explains a product behavior failure.

Verbatim:

```bash
$(cat dd-test-optimization-node-command.txt) "$(cat dd-test-optimization-ci-dir.txt)/test-optimization-validation-link.js" \
  --strict-test-management \
  --from-report dd-test-optimization-final-report.txt \
  --from-report dd-test-optimization-efd/dd-test-optimization-final-report.txt \
  --from-report dd-test-optimization-tm-disabled/dd-test-optimization-final-report.txt \
  --from-report dd-test-optimization-tm-quarantined/dd-test-optimization-final-report.txt \
  --from-report dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-final-report.txt \
  > dd-test-optimization-validation-url.txt

$(cat dd-test-optimization-node-command.txt) -e '
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

function readReportLine (path, prefix) {
  const finalReport = readText(path, "")
  const line = finalReport.split(/\r?\n/).find(line => line.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : "unknown"
}

function readFinalReportLine (prefix) {
  return readReportLine("dd-test-optimization-final-report.txt", prefix)
}

const basic = readJson("dd-test-optimization-agent-report.json", {})
const efd = readJson("dd-test-optimization-efd/dd-test-optimization-agent-report.json", {})
const tmDisabled = readJson("dd-test-optimization-tm-disabled/dd-test-optimization-agent-report.json", {})
const tmQuarantined = readJson("dd-test-optimization-tm-quarantined/dd-test-optimization-agent-report.json", {})
const tmAttemptToFix = readJson("dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-agent-report.json", {})
const staticReport = readJson("dd-test-optimization-static.json", { results: [] })
const staticFindings = (staticReport.results || [])
  .filter(result => result.status === "error" || result.status === "warning")
  .map(result => `${result.status}: ${result.title}`)
const decodeErrors = Array.isArray(basic.summary?.decodeErrors)
  ? basic.summary.decodeErrors.length
  : basic.summary?.decodeErrors || 0
const retriedNewTestNames = efd.summary?.efd?.retriedNewTestNames || []
const agentAdaptations = readText("dd-test-optimization-agent-adaptations.txt", "none")
const eventLevels =
  `sessions=${countEvent(basic, "test_session_end")}, ` +
  `modules=${countEvent(basic, "test_module_end")}, ` +
  `suites=${countEvent(basic, "test_suite_end")}, ` +
  `tests=${countEvent(basic, "test")}`

function getTmStatus (report, exitCode, key, expectedExitCode) {
  if (!report.primaryStage) return "not run"
  const subcheck = report.summary?.tm?.[key]
  if (!subcheck || subcheck.status !== "passed") return `failed: ${subcheck?.reason || "missing subcheck"}`
  if (expectedExitCode === "non-zero") return exitCode !== "0" ? "passed" : "failed: expected non-zero exit"
  return exitCode === expectedExitCode ? "passed" : `failed: expected exit ${expectedExitCode}, got ${exitCode}`
}

function getTmLine (report, key, field) {
  const value = report.summary?.tm?.[key]?.[field]
  if (Array.isArray(value)) return value.join(", ") || "none"
  return value ?? "n/a"
}

function exists (path) {
  try {
    fs.accessSync(path)
    return true
  } catch {
    return false
  }
}

function cleanupStateStatus (files) {
  const remaining = files.filter(exists)
  return remaining.length === 0 ? "ok" : `remaining state: ${remaining.join(", ")}`
}

function cleanupResultStatus (path, fallbackFiles) {
  const result = readJson(path)
  if (!result) return `not recorded; ${cleanupStateStatus(fallbackFiles)}`
  const remainingPaths = (result.paths || [])
    .filter(entry => entry.remaining)
    .map(entry => entry.path)
  const remainingState = result.stateFilesRemaining || []
  if (result.ok && remainingPaths.length === 0 && remainingState.length === 0) return "ok"
  return `remaining paths: ${remainingPaths.join(", ") || "none"}; remaining state: ${remainingState.join(", ") || "none"}`
}

const tmDisabledExit = readText("dd-test-optimization-tm-disabled/dd-test-optimization-test-exit-code.txt", "n/a")
const tmQuarantinedExit = readText("dd-test-optimization-tm-quarantined/dd-test-optimization-test-exit-code.txt", "n/a")
const tmAttemptToFixExit = readText("dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-test-exit-code.txt", "n/a")
const efdCleanupStatus = cleanupStateStatus([
  "dd-test-optimization-efd-temp-test-file.txt",
  "dd-test-optimization-efd-test-name.txt",
])
const atrCleanupStatus = cleanupStateStatus([
  "dd-test-optimization-atr-generated-test-file.txt",
  "dd-test-optimization-atr-flaky-test-file.txt",
  "dd-test-optimization-atr-flaky-test-backup.txt",
  "dd-test-optimization-atr-flaky-test-name.txt",
])
const tmCleanupStatus = cleanupStateStatus([
  "dd-test-optimization-test-management/generated-files.txt",
  "dd-test-optimization-test-management/marker-files.txt",
  "dd-test-optimization-tm-test-file.txt",
  "dd-test-optimization-tm-test-command.txt",
])
const advancedCleanupPathStatus = cleanupResultStatus("dd-test-optimization-advanced-cleanup.json", [
  "dd-test-optimization-efd-temp-test-file.txt",
  "dd-test-optimization-efd-test-name.txt",
  "dd-test-optimization-atr-generated-test-file.txt",
  "dd-test-optimization-atr-flaky-test-file.txt",
  "dd-test-optimization-atr-flaky-test-backup.txt",
  "dd-test-optimization-atr-flaky-test-name.txt",
])
const tmCleanupPathStatus = cleanupResultStatus("dd-test-optimization-test-management-cleanup.json", [
  "dd-test-optimization-test-management/generated-files.txt",
  "dd-test-optimization-test-management/marker-files.txt",
  "dd-test-optimization-tm-test-file.txt",
  "dd-test-optimization-tm-test-command.txt",
])

console.log(`HTML report: ${readText("dd-intake-html-file-url.txt", readFinalReportLine("HTML report:"))}`)
console.log(`HTML report path: ${readText("dd-intake-html-path.txt", readFinalReportLine("HTML report path:"))}`)
console.log(readText("dd-test-optimization-validation-url.txt", `Datadog validation: ${readFinalReportLine("Datadog validation:")}`))
console.log(`Final report path: ${process.cwd()}/dd-test-optimization-final-report.txt`)
console.log(`Compact summary path: ${process.cwd()}/dd-test-optimization-summary.txt`)
console.log(`Selected test command: ${readText("dd-test-optimization-test-command.txt")}`)
console.log(`Advanced test command: ${readText("dd-test-optimization-efd-command.txt")}`)
console.log(`Test result: ${readText("dd-test-optimization-test-result.txt")}`)
console.log(`Basic primary stage: ${basic.primaryStage || "unknown"}`)
console.log(`Basic requests: ${basic.summary?.requestCount ?? "unknown"}`)
console.log(`Event levels: ${eventLevels}`)
console.log(`Decode errors: ${decodeErrors}`)
console.log(`EFD status: ${efd.summary?.efd?.retriedNewTests > 0 ? "passed" : efd.primaryStage ? "failed" : "not run"}`)
console.log(`EFD known tests received: ${efd.summary?.efd?.knownTestsReceived ?? "n/a"}`)
console.log(`EFD retried new tests: ${efd.summary?.efd?.retriedNewTests ?? "n/a"}`)
console.log(`EFD distinct retried new test names: ${new Set(retriedNewTestNames).size}`)
console.log(`EFD retried new test names: ${retriedNewTestNames.join(", ") || "none"}`)
console.log(`EFD execution diagnosis: ${efd.summary?.efd?.execution?.diagnosis || "n/a"}`)
console.log(`Auto Test Retries status: ${efd.summary?.atr?.failedThenPassedRetryTests > 0 ? "passed" : efd.primaryStage ? "failed" : "not run"}`)
console.log(`Auto Test Retries failed executions: ${efd.summary?.atr?.failedExecutions ?? "n/a"}`)
console.log(`Auto Test Retries passed executions: ${efd.summary?.atr?.passedExecutions ?? "n/a"}`)
console.log(`Auto Test Retries passed retry executions: ${efd.summary?.atr?.passedRetryTests ?? "n/a"}`)
console.log(`Auto Test Retries flaky tests reported: ${efd.summary?.atr?.failedThenPassedRetryTests ?? "n/a"}`)
console.log(`Auto Test Retries flaky test names: ${(efd.summary?.atr?.failedThenPassedRetryTestNames || []).join(", ") || "none"}`)
console.log(`Test Management disabled status: ${getTmStatus(tmDisabled, tmDisabledExit, "disabled", "0")}`)
console.log(`Test Management disabled identities: ${getTmLine(tmDisabled, "disabled", "identities")}`)
console.log(`Test Management disabled exit code: ${tmDisabledExit}`)
console.log(`Test Management quarantined status: ${getTmStatus(tmQuarantined, tmQuarantinedExit, "quarantined", "0")}`)
console.log(`Test Management quarantined identities: ${getTmLine(tmQuarantined, "quarantined", "identities")}`)
console.log(`Test Management quarantined exit code: ${tmQuarantinedExit}`)
console.log(`Test Management attempt-to-fix status: ${getTmStatus(tmAttemptToFix, tmAttemptToFixExit, "attemptToFix", "non-zero")}`)
console.log(`Test Management attempt-to-fix identities: ${getTmLine(tmAttemptToFix, "attemptToFix", "identities")}`)
console.log(`Test Management attempt-to-fix retry reasons: ${getTmLine(tmAttemptToFix, "attemptToFix", "observedRetryReasons")}`)
console.log(`Test Management attempt-to-fix exit code: ${tmAttemptToFixExit}`)
console.log(`Cleanup EFD state: ${efdCleanupStatus}`)
console.log(`Cleanup Auto Test Retries state: ${atrCleanupStatus}`)
console.log(`Cleanup Test Management state: ${tmCleanupStatus}`)
console.log(`Cleanup advanced path verification: ${advancedCleanupPathStatus}`)
console.log(`Cleanup Test Management path verification: ${tmCleanupPathStatus}`)
console.log(`Agent adaptations: ${agentAdaptations}`)
console.log(`Static warnings/errors: ${staticFindings.join("; ") || "none"}`)
'
```

The final response must include:

- HTML report `file://` URL and absolute path.
- One Datadog validation relative path for the combined runbook result.
- Final report path and compact summary path.
- Selected test command and test result.
- EFD check result when Step 7 ran, including known tests count, retried new test execution count,
  distinct retried new test name count, and EFD execution diagnosis.
- Auto Test Retries check result when Step 7 ran, including failing executions, passing
  executions, and passing retry executions.
- Test Management disabled, quarantined, and attempt-to-fix results when Step 8 ran.
- Cleanup state and path verification lines for EFD, Auto Test Retries, and Test Management.
- Agent adaptations when command overrides were used.
- The diagnostic question answers with each question text inline.
- Static warnings and errors.
- Recommended next actions.
- Cleanup confirmation for any temporary EFD test file and Auto Test Retries edit.

Files that may remain after a successful run: `dd-test-optimization-final-report.txt`,
`dd-test-optimization-summary.txt`, `dd-test-optimization-report.html`, `dd-test-optimization-*`
JSON/text artifacts, and `dd-test-optimization-*` report directories. Temporary generated source
files must not remain; cleanup path verification must report `ok`.

Minimum final response template:

```text
HTML report: file:///absolute/path/to/dd-test-optimization-report.html
Datadog validation: ci/test/validation#pako:{payload}
Final report path: /absolute/path/to/dd-test-optimization-final-report.txt

Selected test command:
{command}

Advanced test command:
{command}

Test result:
{one-line result}

Pass/fail table:
| Check | Status | Evidence |
| --- | --- | --- |
| Basic reporting | {passed | failed | skipped} | {request/event counts or reason} |
| Early Flake Detection (EFD) | {passed | failed | skipped} | {knownTests/retriedNewTests or reason} |
| Auto Test Retries (ATR) | {passed | failed | skipped} | {failed/passed/retry counts or reason} |
| Test Management | {passed | failed | skipped} | {disabled/quarantined/attemptToFix status or reason} |
| Cleanup | {passed | failed} | {state/path verification summary} |

Basic reporting:
{stage}; requests={count}; events=sessions={count}, modules={count}, suites={count}, tests={count}; decodeErrors={count}

EFD check:
{not run | skipped: reason | passed | failed}; knownTests={count}; retriedNewTests={count}; names={names or none}

Auto Test Retries check:
{not run | skipped: reason | passed | failed}; failed={count}; passed={count}; passingRetries={count}; names={names or none}

Test Management check:
disabled={status} exit={code}; quarantined={status} exit={code}; attemptToFix={status} exit={code} retryReasons={reasons or none}

Cleanup:
EFD={ok | remaining state: ...}; Auto Test Retries={ok | remaining state: ...}; Test Management={ok | remaining state: ...}
Path verification: advanced={ok | remaining paths: ...}; Test Management={ok | remaining paths: ...}

Agent adaptations:
{none | lines from dd-test-optimization-agent-adaptations.txt}

Diagnostic answers:
- Is dd-trace installed and statically configured in a supported way? {answer}
- Does dd-trace/ci/init reach the test process through NODE_OPTIONS? {answer}
- Does a small test subset send Test Optimization requests to a local fake intake? {answer}
- If data is reported, does it include session, module, suite, and test events? {answer}
- Does EFD fetch known tests, mark a new test, and retry it? {answer}
- Does Auto Test Retries retry a failing known test and report retry tags? {answer}
- Does Test Management apply disabled, quarantined, and attempt-to-fix properties? {answer}

Static warnings/errors:
- {finding}

Recommended next actions:
- {action}
```

Add a `Notable execution cases:` section only when needed.

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
DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED=true \
DD_CIVISIBILITY_ENABLED=true \
DD_CIVISIBILITY_FLAKY_RETRY_ENABLED=true \
DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE=false \
DD_INSTRUMENTATION_TELEMETRY_ENABLED=false \
DD_TEST_MANAGEMENT_ENABLED=true \
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

### Stage: Auto Test Retry Missing

Observation: `atr.failedThenPassedRetryTests: 0`.

Cause: Auto Test Retries settings were enabled, but no known flaky test reported both a failed
execution and a passing execution marked with `test.is_retry=true`.

Fix: verify the second run served known tests from the first run, the temporary flaky edit changed
an already known selected test, and the second command selected that flaky known test.

### Stage: Auto Test Retry Reported Flaky Test

Observation: `atr.failedThenPassedRetryTests > 0`.

Cause: the flaky known test reported both failing and passing executions, and the passing
execution was marked as an automatic retry.

Fix: no Auto Test Retries fix is needed for the selected subset.

## Agent Judgment

The fixed rules are deliberately conservative. Use agent judgment when:

- the repository wraps test commands in custom scripts
- tests spawn worker processes or child processes
- framework-specific config changes process boundaries
- the static diagnosis and intake artifact disagree
- requests arrive but payload content looks malformed or unexpectedly sparse

When reality is messier than the rule, keep the artifact and explain the evidence rather than
guessing from symptoms alone.
