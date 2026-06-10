# Test Optimization Debug Runbook for Coding Agents

This runbook is to diagnose Datadog Test Optimization setup problems in a JavaScript repository.
Use repository-specific judgment to adapt commands.

## Mode Selector

- If the user asks to diagnose Test Optimization in this repository, start at Customer Diagnostic
  Mode.
- If the user asks for feedback about this runbook, jump to Runbook Feedback Mode and stop after
  Feedback Mode Step 4.

## Customer Diagnostic Mode: Start Here

Use customer diagnostic mode unless the user explicitly asks for feedback about this runbook.

Customer diagnostic mode uses this path:

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
| `Reporting complete` | Run Step 7 to validate EFD and Auto Test Retries, run Step 8 for Test Management, then Step 9. |
| `Nothing` | Confirm the selected test ran and `NODE_OPTIONS` reached it. Use the manual fallback/debug path only when those are true and the wrapper still captures no requests. Then run Step 9. |
| Any other stage | Skip Step 7 and Step 8, consult the matching Decision Tree stage, then run the Step 9 extractor. |

Feedback mode is below and is only for evaluating this runbook, not for customer diagnosis.

## Runbook Feedback Mode: Exact Path

If the user asks for feedback about this runbook, execute this numbered procedure. Use the
Feedback Fallback Appendix only when Step 1 routes there. Do not use Customer diagnostic mode,
Step 7, Step 8, Step 9, or the Decision Tree unless the fallback path explicitly requires them.
Stop after Feedback Mode Step 4.

1. Run the Feedback Driver:

   If `./node_modules/dd-trace` exists, run:

   ```bash
   node ./node_modules/dd-trace/ci/test-optimization-feedback-runner.js
   ```

   If this repository uses Yarn PnP, portal dependencies, or a command guard that rejects bare
   `node`, resolve the script through Yarn and run it with `yarn node`:

   ```bash
   yarn node "$(yarn node -e 'process.stdout.write(require.resolve("dd-trace/ci/test-optimization-feedback-runner.js"))')"
   ```

   Expected for every completed driver run: `Feedback driver status: {"fresh":true`,
   `Selected source files are clean after feedback-mode wrapper.`, `Root wrapper stage:`,
   `Advanced checks:`, and `Wrapper log:`.

   Expected only when the root wrapper stage is `Reporting complete`: `Temporary EFD file absent:`,
   `EFD retried new tests:`, and `Auto Test Retries flaky tests reported:`.

   Before applying the routing table, verify `dd-test-optimization-agent-report.json` was produced
   or refreshed by this Step 1 driver attempt. If the driver was denied before execution, Step 0
   did not run, or the report file predates the current feedback-mode attempt, treat the report as
   missing. Do not render or rely on stale artifacts from a previous run.

   If the tool supports reusable approval prefixes, use the command form that worked in this
   repository for loopback approval. For node_modules repositories:

   ```text
   node ./node_modules/dd-trace/ci/test-optimization-feedback-runner.js
   ```

   For Yarn PnP or portal repositories:

   ```text
   yarn node <resolved path to test-optimization-feedback-runner.js>
   ```

   If the command tool accepts structured approval fields, use:

   ```text
   sandbox_permissions: "require_escalated"
   justification: "Allow the feedback driver to bind and connect to 127.0.0.1 for the local fake intake."
   prefix_rule: ["node", "./node_modules/dd-trace/ci/test-optimization-feedback-runner.js"]
   ```

   | Driver result | Next action |
   | --- | --- |
   | `listen EPERM: operation not permitted 127.0.0.1` | Rerun the same Feedback Driver command with loopback approval. If the approved rerun succeeds, do not count the initial unapproved EPERM as a failed runbook execution. Continue to Step 2. |
   | Non-EPERM failure and `dd-test-optimization-agent-report.json` is missing | Use the Feedback Fallback Appendix F0a-F7, then resume at Step 2. |
   | Non-EPERM failure and current-run `dd-test-optimization-agent-report.json` exists, and F9 can render a summary | Do not use the fallback appendix. Continue to Step 2, write `No actionable feedback.` unless the instructions were unclear. A diagnostic failure such as `EFD retry missing` is not runbook feedback by itself. Run F9 and report the F9 output plus the feedback. |
   | Non-EPERM failure and current-run `dd-test-optimization-agent-report.json` exists, but F9 cannot render a summary | Continue to Step 2, write the runbook-consumability issue that made the path ambiguous or incomplete, and report the failure. |
   | Driver exits successfully and root stage is not `Reporting complete` | Continue to Step 2, write `No actionable feedback.` unless the instructions were unclear, run F9, and report the F9 diagnostic outcome. Missing EFD/ATR evidence is expected when the root stage is not `Reporting complete`. |
   | Driver exits successfully, root stage is `Reporting complete`, and the Reporting-complete Expected strings are present | Continue to Step 2. |
   | Driver exits successfully, root stage is `Reporting complete`, and one or more Reporting-complete Expected strings are missing | Continue to Step 2, write the missing expected evidence or unclear routing as actionable feedback when it reflects runbook friction, run F9, and report the F9 output plus the feedback. |

   Feedback-mode happy path: run the driver, write the feedback artifact from runbook execution
   friction only, run F9 in the normal sandbox, respond from F9 output or the caller's constrained
   response shape, then stop.

   Feedback mode only requires these Node commands:
   `node ./node_modules/dd-trace/ci/test-optimization-feedback-runner.js` and
   `node ./node_modules/dd-trace/ci/test-optimization-feedback-summary.js`, or their package-manager
   equivalents such as `yarn node <resolved dd-trace script>` in Yarn PnP repositories.

2. Create or overwrite the feedback artifact now:

   File: `dd-test-optimization-actionable-feedback.txt`

   Use the agent environment's file-write or edit tool first. If no file-write/edit tool is
   available, use shell redirection such as `printf` or `cat >`. If neither path is available,
   report that feedback artifact creation is blocked.

   Allowed file shapes:

   ```text
   No actionable feedback.
   ```

   or:

   ```text
   - Change {specific instruction or command}. Reason: {why this helps a coding agent}.
   - Change {specific instruction or command}. Reason: {why this helps a coding agent}.
   ```

   Review scope: evaluate the exact feedback path and any sections that were needed to execute it.
   Review fallback or customer-diagnostic sections only when the run used them, they blocked the
   exact path, or the user explicitly asked for a full-file editorial review.

   The feedback artifact must contain only runbook-consumability issues discovered during this
   execution. Do not write Test Optimization diagnostic findings, product findings, repository
   warnings, or successful diagnostic outcomes into this file.

   Actionable feedback is a change that would make the runbook easier or safer for the next coding
   agent to execute. Examples: missing command routing, ambiguous step order, unclear substitution
   rules, missing permission or retry guidance, source cleanup uncertainty, artifact mismatch
   handling, or output requirements that caused duplicate, truncated, or misleading reports.
   Non-actionable feedback includes successful execution notes, repository-specific warnings already
   reported by the diagnosis, or preferences that do not change runbook execution.

3. Run F9 in the normal sandbox, meaning no loopback or escalated approval:

   If `./node_modules/dd-trace` exists, run:

   ```bash
   node ./node_modules/dd-trace/ci/test-optimization-feedback-summary.js
   ```

   If this repository uses Yarn PnP, portal dependencies, or a command guard that rejects bare
   `node`, run:

   ```bash
   yarn node "$(yarn node -e 'process.stdout.write(require.resolve("dd-trace/ci/test-optimization-feedback-summary.js"))')"
   ```

   Expected: compact feedback summary, `Pre-existing worktree changes`, and
   `Current diagnostic artifacts`; also writes `dd-test-optimization-feedback-summary.txt`.
   F9 reads artifacts and writes summary files; it does not bind the fake intake or run tests, so
   it should not use loopback approval after the Feedback Driver succeeds.
   If F9 itself exposes a runbook-consumability issue that was not written in Step 2, update
   `dd-test-optimization-actionable-feedback.txt` and rerun this F9 command once.

4. Stop. If the caller asked only for runbook feedback, respond with one sentence of execution
   evidence, then the requested runbook feedback under `Actionable feedback`. Otherwise include
   the compact diagnostic summary because this runbook requires execution evidence, then include
   the requested runbook feedback under `Actionable feedback`. If the invoking prompt explicitly
   requires a constrained final response shape, obey that constraint after Steps 1-3 have produced
   the F9 terminal output and artifacts. Do not replace runbook feedback with Test Optimization
   diagnostic findings. Respond using the F9 terminal output directly; do not re-read artifact
   files to reconstruct fields already printed by F9. If F9 ran successfully, use its terminal
   output as-is when the caller did not ask only for feedback. If the terminal output is truncated,
   read `dd-test-optimization-feedback-summary.txt` for the compact summary and append the terminal
   worktree/artifact sections only if they were not already included.

   Default response shape, used only when F9 output is unavailable or too truncated to relay:

   ```text
   Runbook completed: {yes | no, explain}
   Diagnostic outcome: {basic reporting worked | basic reporting did not work | runbook failed, explain}
   Basic reporting: {stage}, requests={count}, event levels={summary}, decode errors={count}
   EFD: {passed | failed | skipped: reason | not run}, known tests={count}, retried new tests={retry execution count}, distinct retried names={count}
   Auto Test Retries: {passed | failed | skipped: reason | not run}, failed={count}, passed={count}, retry passes={count}
   Reports: {HTML file URL}, {final report path}, {compact summary path}
   Cleanup: {temporary EFD removed/restored status}, {flaky edit restored status}. Diagnostic artifacts intentionally remain untracked until the next Step 0 cleanup.
   Actionable feedback:
   - {feedback or "No actionable feedback."}
   Pre-existing worktree changes:
   {non-diagnostic status lines or "none"}
   Current diagnostic artifacts:
   {diagnostic artifact status lines or "none"}
   ```

**Feedback mode ends here. Do not read further unless Step 1 routed to the Feedback Fallback
Appendix.**

## Agent Quickstart

Choose one mode first:

- Customer diagnostic mode: use the Preferred Wrapper, Step 7, Step 8, and Step 9 final response checklist.
- Runbook feedback mode: use `Runbook Feedback Mode: Exact Path` above.

Loopback prerequisite: if the first wrapper command returns
`listen EPERM: operation not permitted 127.0.0.1`, rerun that command with loopback bind/connect
approval. After loopback approval has been granted once, run every later wrapper command with that
approval immediately.

Commands that need loopback approval: feedback-driver and wrapper commands that run
`node ./node_modules/dd-trace/ci/test-optimization-feedback-runner.js` or
`node ./node_modules/dd-trace/ci/test-optimization-debug.js`, plus package-manager equivalents
such as `yarn node <resolved test-optimization-feedback-runner.js>` or
`yarn node <resolved test-optimization-debug.js>`. Analyzer, prepare, restore, feedback-summary,
and extractor commands read artifacts or edit files; they do not bind the fake intake or run the
test process against it.

For Codex, Claude Code, and other sandboxed command runners: request loopback/escalated approval
only for wrapper commands that bind or connect to `127.0.0.1`. Keep cleanup, discovery, analyzer,
prepare, restore, and feedback-summary commands in the normal sandbox unless they fail for a
non-loopback permission reason.

Step 1 is optional on the wrapper path. Run Step 1 only when static diagnosis is useful before
choosing the selected test command. The root wrapper always writes
`dd-test-optimization-static.json`.

Use the wrapper path first in customer diagnostic mode. Do not run manual Steps 3-6 after a wrapper
run reports `Reporting complete`; go directly to Step 7.

For runbook feedback mode, use only `Runbook Feedback Mode: Exact Path` above unless the feedback
fallback condition applies.

Customer diagnostic mode, Preferred Wrapper, Step 7, Step 8, Step 9, and the Decision Tree are out of
scope for feedback runs unless the feedback fallback condition applies.

Feedback fallback condition: use F1-F7 only when F-runner is unavailable, fails before producing
root artifacts after a non-EPERM error, or reports `Nothing` after the selected test clearly ran
and `NODE_OPTIONS` reached it. Do not use F1-F7 for `listen EPERM`; rerun the whole F-runner block
with loopback approval.

Do not run generic Step 0 cleanup separately in feedback mode. F0a is the pre-discovery cleanup.
Use generic Step 0 only when recovering manually from an interrupted run with stale helper-created
source edits.

In feedback mode, do not use the required final response checklist or the final response template.
Do not run the Step 9 field extractor unless you need extra local inspection; the feedback-summary
renderer in F9 reads the required artifacts directly.

Feedback-mode artifact rule: diagnostic artifacts may remain untracked until the next Step 0
cleanup. Helper-created source edits and helper state files must be gone before responding.

**STOP for successful feedback runs:** after Step 4, do not read or run the Feedback Fallback
Appendix. Use the appendix only when the Step 1 routing table sends you there.

## Feedback Fallback Appendix (F0a-F7)

Use this appendix only when the Step 1 routing table sends you here. Do not read or run
these blocks after the Feedback Driver succeeds.

Fallback checklist:

| Block | When to run | Sandbox / loopback mode | Expected artifact or state |
| --- | --- | --- | --- |
| Feedback Driver | Preferred feedback path | loopback approval may be required | root, baseline, and advanced artifacts; source edits restored |
| F0a | Before discovery | normal sandbox | preexisting status captured; stale artifacts removed |
| F0-discovery | After F0a | normal sandbox | package, git status, test files, and config files inspected |
| F0-select | After F0-discovery | normal sandbox | selected command and selected files input files |
| F0b | After F0-select | normal sandbox | selected command and selected files state |
| F-runner | After F0b | loopback approval may be required | root, baseline, and advanced artifacts; wrapper log; source edits restored |
| F-runner-postcheck | After F-runner | normal sandbox | selected source files clean; temporary EFD file absent |
| F1-F7 | Fallback only when the feedback fallback condition applies | mixed | same artifacts as F-runner |

After the last fallback block, resume `Runbook Feedback Mode: Exact Path` at Step 2.

F0a: clean stale diagnostic artifacts before discovery.

```bash
set -e

# [normal sandbox] Capture non-diagnostic worktree changes before cleanup.
rm -f dd-test-optimization-preexisting-status.txt
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git status --short | grep -Ev '^\?\? (dd-test-optimization|dd-intake)|^\?\? nohup\.out$' \
    > dd-test-optimization-preexisting-status.txt || true
  if [ ! -s dd-test-optimization-preexisting-status.txt ]; then
    printf '%s\n' 'none' > dd-test-optimization-preexisting-status.txt
  fi
else
  printf '%s\n' 'not a git worktree' > dd-test-optimization-preexisting-status.txt
fi

# [normal sandbox] Clean prior diagnostic artifacts and recorded helper state.
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
  dd-test-optimization-env.txt \
  dd-test-optimization-advanced-validation-url.txt \
  dd-test-optimization-efd-command.txt \
  dd-test-optimization-efd-test-name.txt \
  dd-test-optimization-efd-validation-url.txt \
  dd-test-optimization-efd-new-test-snippet.txt \
  dd-test-optimization-efd-temp-test-file.txt \
  dd-test-optimization-feedback-summary.txt \
  dd-test-optimization-feedback-wrapper.log \
  dd-test-optimization-selected-command.input \
  dd-test-optimization-selected-files.input \
  dd-test-optimization-atr-flaky-test-backup.txt \
  dd-test-optimization-atr-flaky-test-file.txt \
  dd-test-optimization-atr-flaky-test-name.txt \
  dd-test-optimization-atr-flaky-test-snippet.txt \
  dd-test-optimization-actionable-feedback.txt \
  dd-test-optimization-known-tests.json \
  dd-test-optimization-advanced-dry-run.txt \
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
  dd-test-optimization-root-stage.txt \
  dd-test-optimization-summary.txt \
  nohup.out

rm -rf \
  dd-test-optimization-basic \
  dd-test-optimization-efd \
  dd-test-optimization-efd-only \
  dd-test-optimization-atr-only
```

F0-discovery: inspect the repository before F0-select.

```bash
node -e '
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

printf '%s\n' 'Pre-existing non-diagnostic worktree changes:'
cat dd-test-optimization-preexisting-status.txt 2>/dev/null || \
  git status --short | grep -Ev '^\?\? (dd-test-optimization|dd-intake)|^\?\? nohup\.out$' || true

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

Use these criteria to validate the F0-select helper output, or to override it if the helper is
unavailable or chooses the wrong file. Run F0-select before manually writing a command.

The selected command must genuinely run tests. Prefer a clean test file that is not listed in
`git status --short`, and preserve the repository's normal runner command when possible.

Common selected-command patterns:

- Yarn + Jest: `yarn test path/to/file.test.ts --runInBand`
- npm + Jest: `npm test -- path/to/file.test.ts --runInBand`
- Yarn + Mocha where `scripts.test` is Mocha: `yarn test test/foo.spec.js`
- npm + Mocha where `scripts.test` is Mocha: `npm test -- test/foo.spec.js`
- Direct local runner when no package script fits: `./node_modules/.bin/jest path/to/file.test.js`
- Vitest: `npm test -- path/to/file.test.ts` or `./node_modules/.bin/vitest run path/to/file.test.ts`
- Cypress: use the repository command with one `--spec path/to/spec.cy.ts` equivalent.
- Playwright: use the repository command with one file path or one grep filter.

Do not copy these examples literally unless the file exists in the current repository. The selected
test file paths written below must match the command.

F0-select: write the selected command and selected test files.

Run the clean-test selection helper first. It filters out files listed by `git status --short`,
prefers small unit-style tests, and writes both F0-select input files.

```bash
node ./node_modules/dd-trace/ci/test-optimization-select-command.js
```

Inspect the printed command and file. If the helper selected the wrong file or cannot infer a
command, write the selected command and selected test files manually. Replace both `FILL_IN` values
before running:

```bash
printf '%s\n' 'FILL_IN selected test command' > dd-test-optimization-selected-command.input
printf '%s\n' 'FILL_IN selected test file path' > dd-test-optimization-selected-files.input
```

For multiple selected test files, write one path per line to
`dd-test-optimization-selected-files.input`.

F0b: write and validate the selected command.

```bash
set -e

if [ -n "${DD_TEST_OPTIMIZATION_SELECTED_COMMAND:-}" ]; then
  SELECTED_TEST_COMMAND="$DD_TEST_OPTIMIZATION_SELECTED_COMMAND"
elif [ -s dd-test-optimization-selected-command.input ]; then
  SELECTED_TEST_COMMAND="$(cat dd-test-optimization-selected-command.input)"
else
  echo "Write dd-test-optimization-selected-command.input or set DD_TEST_OPTIMIZATION_SELECTED_COMMAND."
  exit 1
fi

SELECTED_TEST_FILES_FILE="${DD_TEST_OPTIMIZATION_SELECTED_FILES_FILE:-dd-test-optimization-selected-files.input}"
if [ ! -s "$SELECTED_TEST_FILES_FILE" ]; then
  echo "Write dd-test-optimization-selected-files.input or set DD_TEST_OPTIMIZATION_SELECTED_FILES_FILE."
  exit 1
fi

# [normal sandbox] Write and validate the selected command.
printf 'Selected test command: %s\n' "$SELECTED_TEST_COMMAND"
printf '%s\n' "$SELECTED_TEST_COMMAND" > dd-test-optimization-test-command.txt
sed '/^[[:space:]]*$/d' "$SELECTED_TEST_FILES_FILE" > dd-test-optimization-selected-test-files.txt
printf '%s\n' 'unknown' > dd-test-optimization-test-result.txt
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
    if [ "${DD_TEST_OPTIMIZATION_ALLOW_DIRTY_SELECTED_TESTS:-}" != "1" ]; then
      echo "Selected test files have local changes." >&2
      echo "Choose clean files or set DD_TEST_OPTIMIZATION_ALLOW_DIRTY_SELECTED_TESTS=1." >&2
      exit 1
    fi
    echo "Selected test files have local changes; override accepted."
  else
    echo "Selected test files are clean."
  fi
fi
```

F-runner: run the feedback-mode wrapper. This block may require loopback approval. If it fails
with `listen EPERM`, rerun this entire F-runner bash block with loopback approval. Do not rerun
only the inner `node ./node_modules/dd-trace/ci/test-optimization-debug.js` line; the log handling
and compact-status postprocessing must run in the same approved block. It replaces F1-F7 in the
normal feedback path and restores temporary advanced-check source edits on failure.
One successful F-runner command runs multiple wrapper passes internally: root basic reporting,
baseline known-tests capture, and advanced EFD/Auto Test Retries. The wrapper log captures full
test output and `Datadog validation:` lines. On success, this block prints only compact status.
On failure, it prints the wrapper log before exiting. Continue to F-runner-postcheck after the
command exits successfully.

Approval target: execute the whole F-runner bash block below with loopback approval.

Reusable loopback approval prefix for this block:

```text
node ./node_modules/dd-trace/ci/test-optimization-debug.js
```

The reusable prefix is only the approval rule for the inner wrapper process. The command to rerun
after `listen EPERM` is the complete bash block, including `WRAPPER_LOG`, status capture, failure
log printing, and compact-status postprocessing.

```bash
set -e

WRAPPER_LOG=dd-test-optimization-feedback-wrapper.log
set +e
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --feedback-mode \
  --test-command-file dd-test-optimization-test-command.txt \
  --selected-test-files-file dd-test-optimization-selected-test-files.txt \
  --no-open > "$WRAPPER_LOG" 2>&1
WRAPPER_STATUS=$?
set -e

if [ "$WRAPPER_STATUS" -ne 0 ]; then
  cat "$WRAPPER_LOG"
  exit "$WRAPPER_STATUS"
fi

node -e '
const fs = require("node:fs")

function readReport (file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

const root = readReport("dd-test-optimization-agent-report.json")
const advanced = readReport("dd-test-optimization-efd/dd-test-optimization-agent-report.json")
console.log(`Root wrapper stage: ${root.primaryStage || "unknown"}`)
console.log(`Root requests: ${root.summary?.requestCount ?? "unknown"}`)
console.log(`Advanced checks: ${advanced.primaryStage || "unknown"}`)
console.log(`EFD retried new tests: ${advanced.summary?.efd?.retriedNewTests ?? "unknown"}`)
console.log(`Auto Test Retries flaky tests reported: ${advanced.summary?.atr?.failedThenPassedRetryTests ?? "unknown"}`)
console.log(`Wrapper log: ${process.cwd()}/dd-test-optimization-feedback-wrapper.log`)
'
```

F-runner-postcheck: verify feedback-mode temporary source edits were restored.

```bash
set -e

EFD_TEMP_FILE="$(sed -n 's/^Temporary EFD test file: //p' dd-test-optimization-advanced-dry-run.txt 2>/dev/null | tail -n 1)"
if [ -n "$EFD_TEMP_FILE" ]; then
  test ! -f "$EFD_TEMP_FILE"
  printf 'Temporary EFD file absent: %s\n' "$EFD_TEMP_FILE"
fi

if [ -s dd-test-optimization-selected-test-files.txt ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r file; do
    git diff --exit-code -- "$file"
    git diff --cached --exit-code -- "$file"
  done < dd-test-optimization-selected-test-files.txt
  printf '%s\n' 'Selected source files are clean after feedback-mode wrapper.'
fi

test ! -f dd-test-optimization-efd-temp-test-file.txt
test ! -f dd-test-optimization-atr-flaky-test-file.txt
test ! -f dd-test-optimization-atr-flaky-test-backup.txt
```

F1-F7 fallback: use these blocks only when the feedback fallback condition applies: F-runner is
unavailable, fails before producing root artifacts after a non-EPERM error, or reports `Nothing`
after the selected test clearly ran and `NODE_OPTIONS` reached it. Do not use F1-F7 for
`listen EPERM`; rerun the whole F-runner block with loopback approval.

F1: run the root wrapper. This block may require loopback approval.

```bash
set -e

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command-file dd-test-optimization-test-command.txt \
  --no-open
```

F2: record the root stage.

```bash
set -e

ROOT_STAGE="$(node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-agent-report.json", "utf8"))
console.log(report.primaryStage || "unknown")
')"
printf '%s\n' "$ROOT_STAGE" > dd-test-optimization-root-stage.txt
printf 'Root wrapper stage: %s\n' "$ROOT_STAGE"
```

If F2 prints a value other than `Reporting complete`, skip F3 through F7 and return to
`Runbook Feedback Mode: Exact Path` at Step 2.

F3a: guard the baseline advanced-check wrapper.

```bash
set -e

ROOT_STAGE="$(cat dd-test-optimization-root-stage.txt)"
if [ "$ROOT_STAGE" != "Reporting complete" ]; then
  printf 'Root wrapper stage was not Reporting complete: %s\n' "$ROOT_STAGE"
  exit 0
fi
printf 'Root wrapper stage allows advanced checks: %s\n' "$ROOT_STAGE"
```

F3b: run the baseline advanced-check wrapper. This block may require loopback approval.

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command-file dd-test-optimization-test-command.txt \
  --out-dir dd-test-optimization-basic \
  --no-open
```

F4: extract known tests and dry-run temporary advanced-check edits.

```bash
set -e

ROOT_STAGE="$(cat dd-test-optimization-root-stage.txt)"
if [ "$ROOT_STAGE" != "Reporting complete" ]; then
  printf 'Root wrapper stage was not Reporting complete: %s\n' "$ROOT_STAGE"
  exit 0
fi

node ./node_modules/dd-trace/ci/test-optimization-analyze-intake.js \
  dd-test-optimization-basic/dd-test-optimization-intake.json \
  --json \
  --known-tests-out dd-test-optimization-known-tests.json \
  > dd-test-optimization-basic/dd-test-optimization-agent-report.json

node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --auto --dry-run \
  | tee dd-test-optimization-advanced-dry-run.txt

node -e '
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

function fail (message) {
  console.error(message)
  process.exit(1)
}

function normalize (file) {
  return path.normalize(file)
}

function dryRunValue (prefix, isPath = true) {
  const line = fs.readFileSync("dd-test-optimization-advanced-dry-run.txt", "utf8")
    .split(/\r?\n/)
    .find(line => line.startsWith(prefix))
  if (!line) fail(`Dry run did not print: ${prefix}`)
  const value = line.slice(prefix.length).trim()
  return isPath ? normalize(value) : value
}

const selectedFiles = fs.readFileSync("dd-test-optimization-selected-test-files.txt", "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(normalize)
const selectedDirs = new Set(selectedFiles.map(file => path.dirname(file)))
const efdFile = dryRunValue("Temporary EFD test file: ")
const flakyFile = dryRunValue("Auto Test Retries flaky test file: ")
const flakyTestName = dryRunValue("Auto Test Retries flaky test name: ", false)
const knownTests = JSON.parse(fs.readFileSync("dd-test-optimization-known-tests.json", "utf8"))

if (!selectedDirs.has(path.dirname(efdFile))) {
  fail(`Temporary EFD file is not under a selected test directory: ${efdFile}`)
}
if (fs.existsSync(efdFile)) {
  fail(`Temporary EFD file already exists: ${efdFile}`)
}
if (!selectedFiles.includes(flakyFile)) {
  fail(`Auto Test Retries flaky file is not one of the selected test files: ${flakyFile}`)
}

const gitStatus = spawnSync("git", ["status", "--short", "--", flakyFile], { encoding: "utf8" })
if (gitStatus.status === 0 && gitStatus.stdout.trim()) {
  fail(`Auto Test Retries flaky file is not clean: ${flakyFile}`)
}
if (gitStatus.status !== 0) {
  fail(`Could not verify git status for: ${flakyFile}`)
}

let knownTestFound = false
for (const suites of Object.values(knownTests || {})) {
  for (const [suite, tests] of Object.entries(suites || {})) {
    if (normalize(suite) === flakyFile && Array.isArray(tests) && tests.includes(flakyTestName)) {
      knownTestFound = true
    }
  }
}
if (!knownTestFound) {
  fail(`Auto Test Retries flaky test name is not known for the selected file: ${flakyTestName}`)
}

console.log("Advanced dry-run guardrails: passed")
'
```

The machine-checkable guard prints `Advanced dry-run guardrails: passed` before F5.
It verifies all of these:

- the temporary EFD file is under the selected test directory
- the temporary EFD file does not already exist
- the Auto Test Retries flaky test file is one of the clean selected test files
- the Auto Test Retries flaky test name belongs to the selected subset

Use a different clean selected test or the explicit helper form if any dry-run target is
unexpected.

Explicit helper dry-run template:

```bash
node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js \
  --framework jest \
  --known-tests-file dd-test-optimization-known-tests.json \
  --test-command-file dd-test-optimization-test-command.txt \
  --efd-test-file path/to/dd-trace-efd-debug.test.ts \
  --flaky-test-file path/to/existing-clean-test.test.ts \
  --flaky-test-name 'suite-qualified known test name' \
  --efd-command 'yarn test path/to/existing-clean-test.test.ts path/to/dd-trace-efd-debug.test.ts' \
  --dry-run
```

If the explicit dry run is correct, use the same command without `--dry-run` in F5
instead of `test-optimization-prepare-advanced.js --auto`.

F5: apply temporary advanced-check edits.

```bash
set -e

ROOT_STAGE="$(cat dd-test-optimization-root-stage.txt)"
if [ "$ROOT_STAGE" != "Reporting complete" ]; then
  printf 'Root wrapper stage was not Reporting complete: %s\n' "$ROOT_STAGE"
  exit 0
fi

node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --auto
```

F6a: guard the advanced EFD and Auto Test Retries wrapper.

```bash
set -e

ROOT_STAGE="$(cat dd-test-optimization-root-stage.txt)"
if [ "$ROOT_STAGE" != "Reporting complete" ]; then
  printf 'Root wrapper stage was not Reporting complete: %s\n' "$ROOT_STAGE"
  exit 0
fi
printf 'Root wrapper stage allows advanced wrapper: %s\n' "$ROOT_STAGE"
```

F6b: run the advanced EFD and Auto Test Retries wrapper. This block may require loopback approval.

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command-file dd-test-optimization-efd-command.txt \
  --settings-mode debug-all \
  --known-tests dd-test-optimization-known-tests.json \
  --new-test-snippet-file dd-test-optimization-efd-new-test-snippet.txt \
  --flaky-test-snippet-file dd-test-optimization-atr-flaky-test-snippet.txt \
  --out-dir dd-test-optimization-efd \
  --no-open
```

F7: assert advanced evidence and restore temporary source edits.

```bash
set -e

ROOT_STAGE="$(cat dd-test-optimization-root-stage.txt)"
if [ "$ROOT_STAGE" != "Reporting complete" ]; then
  printf 'Root wrapper stage was not Reporting complete: %s\n' "$ROOT_STAGE"
  exit 0
fi

node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("dd-test-optimization-efd/dd-test-optimization-agent-report.json", "utf8"))
function assertPassed (condition, message) {
  if (condition) return
  console.error(message)
  process.exit(1)
}
assertPassed(report.summary.efd.settingsEnabled, "EFD settings were not enabled.")
assertPassed(report.summary.efd.requested, "Known tests were not requested.")
assertPassed(report.summary.efd.knownTestsReceived > 0, "Known tests response was empty.")
assertPassed(report.summary.efd.retriedNewTests > 0, "No new test was retried by EFD.")
assertPassed(report.summary.atr.settingsEnabled, "Auto Test Retries settings were not enabled.")
assertPassed(report.summary.atr.failedExecutions > 0, "No failing execution was reported.")
assertPassed(report.summary.atr.passedExecutions > 0, "No passing execution was reported.")
assertPassed(report.summary.atr.passedRetryTests > 0, "No passing retry execution was reported.")
assertPassed(report.summary.atr.failedThenPassedRetryTests > 0, "No known flaky test failed and passed on retry.")
console.log(`EFD retried new tests: ${report.summary.efd.retriedNewTests}`)
console.log(`Auto Test Retries flaky tests reported: ${report.summary.atr.failedThenPassedRetryTests}`)
'

node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --restore

test ! -f dd-test-optimization-efd-temp-test-file.txt
test ! -f dd-test-optimization-atr-flaky-test-file.txt
test ! -f dd-test-optimization-atr-flaky-test-backup.txt
```

After the fallback path completes, return to Step 2 and Step 3 in
`Runbook Feedback Mode: Exact Path` to write actionable feedback and render F9. Do not continue
into customer diagnostic mode, Step 7, Step 8, Step 9, the Decision Tree, or the customer final response
checklist unless the fallback path explicitly required those sections.

Customer diagnostic mode uses the Preferred Wrapper, Step 7, Step 8, and Step 9 sections below. Its wrapper
result routing is:

| Root wrapper result | Next action |
| --- | --- |
| `listen EPERM: operation not permitted 127.0.0.1` | Rerun the wrapper with loopback bind/connect approval. Do not diagnose Test Optimization from this result. |
| `Reporting complete` | Run Step 7 to validate EFD and Auto Test Retries, run Step 8 to validate Test Management, then Step 9. |
| `Nothing` | Confirm the selected test ran and `NODE_OPTIONS` reached it. Use the manual fallback/debug path only when those are true and the wrapper still captures no requests. Then run Step 9. |
| Any other stage | Skip Step 7 and Step 8, consult the matching Decision Tree stage, then run the Step 9 extractor. |

## Detailed Section Index

The Agent Quickstart above is the canonical execution flow. The detailed sections below provide
the commands and adaptation rules for each referenced step:

- Step 0: cleanup and source-edit restore safety.
- Step 2: selected test command discovery.
- Preferred Wrapper: root wrapper command details.
- Step 7: advanced EFD and Auto Test Retries checks when basic reporting is complete.
- Step 8: Test Management disabled, quarantined, and attempt-to-fix checks.
- Step 9: machine-oriented extractor and final response format.

Feedback-mode fallback condition: use F1-F7 only when F-runner is unavailable, fails before
producing root artifacts after a non-EPERM error, or reports `Nothing` after the selected test
clearly ran and `NODE_OPTIONS` reached it. Do not use F1-F7 for `listen EPERM`; rerun the whole
F-runner block with loopback approval.

Customer-mode manual fallback condition: use manual Steps 3-6 only when the wrapper is unavailable,
fails before producing artifacts, reports `Nothing` after a confirmed test run, or requires
repository-specific process handling. A successful wrapper run with `Reporting complete` means
manual Steps 3-6 are skipped.

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
- Datadog validation relative path, plus advanced validation relative path when Step 7 ran.
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

The Agent Quickstart above is the authoritative wrapper flow. Apply the top-level loopback
prerequisite for sandboxed environments.

After completing Step 2, use only the selected-command file form:

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command-file dd-test-optimization-test-command.txt \
  --no-open
```

Sandbox note: `listen EPERM 127.0.0.1` is a local environment permission failure, not a Test
Optimization reporting failure. Use the loopback prerequisite at the top of this runbook.

If the environment records reusable approvals, approve the command prefix for the wrapper:

```text
node ./node_modules/dd-trace/ci/test-optimization-debug.js
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
- `test-optimization-feedback-summary.js`: feedback-mode F9 summary and status renderer.
- `test-optimization-intake-analysis.js`: shared decision-tree rules.
- `test-optimization-select-command.js`: clean-test command selector for feedback-mode F0-select.

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
  dd-test-optimization-env.txt \
  dd-test-optimization-advanced-validation-url.txt \
  dd-test-optimization-efd-command.txt \
  dd-test-optimization-efd-test-name.txt \
  dd-test-optimization-efd-validation-url.txt \
  dd-test-optimization-efd-new-test-snippet.txt \
  dd-test-optimization-efd-temp-test-file.txt \
  dd-test-optimization-feedback-summary.txt \
  dd-test-optimization-feedback-wrapper.log \
  dd-test-optimization-selected-command.input \
  dd-test-optimization-selected-files.input \
  dd-test-optimization-atr-flaky-test-backup.txt \
  dd-test-optimization-atr-flaky-test-file.txt \
  dd-test-optimization-atr-flaky-test-name.txt \
  dd-test-optimization-atr-flaky-test-snippet.txt \
  dd-test-optimization-actionable-feedback.txt \
  dd-test-optimization-known-tests.json \
  dd-test-optimization-advanced-dry-run.txt \
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
  dd-test-optimization-atr-only
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
node -e '
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

Set `SELECTED_TEST_COMMAND` to the selected command, then write it:

Common Yarn + Jest example:

```bash
SELECTED_TEST_COMMAND='yarn test packages/plugin-gate/src/__tests__/scope.test.ts'
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
- helper-edited known test file containing `dd trace auto retry debug flake`

During Step 8, these temporary source files may appear:

- helper-created `dd-trace-tm-disabled*.test.*` or `dd-trace-tm-disabled*.spec.*`
- helper-created `dd-trace-tm-quarantined*.test.*` or `dd-trace-tm-quarantined*.spec.*`
- helper-created `dd-trace-tm-attempt-to-fix*.test.*` or `dd-trace-tm-attempt-to-fix*.spec.*`

After Step 7e restore, the temporary EFD test file must be gone and the flaky edit must be gone
from the known test file. Existing unrelated dirty files in the repository must remain untouched.
After each Step 8 restore, the generated Test Management test file and marker file must be gone.

After helper restore, these temporary source-edit state files must be absent:

- `dd-test-optimization-efd-temp-test-file.txt`
- `dd-test-optimization-efd-test-name.txt`
- `dd-test-optimization-atr-flaky-test-file.txt`
- `dd-test-optimization-atr-flaky-test-backup.txt`
- `dd-test-optimization-atr-flaky-test-name.txt`

These diagnostic artifacts may remain after helper restore:

- `dd-test-optimization-efd-new-test-snippet.txt`
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

- First run: capture the currently known tests from the selected subset.
- Second run: serve those known tests, add one new deterministic passing test, make one already
  known test fail once and then pass, and verify that both EFD and Auto Test Retries worked.

Step 7 always runs the wrapper again with `--out-dir`; do not reuse the root wrapper artifact as the
advanced-check baseline.

7a. Run the first baseline run in its own artifact directory and extract known tests:

Required: use `--out-dir "$BASIC_DIR"` to avoid overwriting root artifacts. It prevents the
baseline advanced-check run from overwriting the root wrapper artifacts used for Step 9.
Use the top-level loopback prerequisite if the wrapper fails with `listen EPERM 127.0.0.1`.

Verbatim:

```bash
set -e

BASIC_DIR=dd-test-optimization-basic

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command-file dd-test-optimization-test-command.txt \
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
node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --auto --dry-run
```

The next command intentionally modifies repository source temporarily:

- creates one sibling EFD test file
- edits one known test so its first execution fails and its retry passes
- records enough state for `test-optimization-prepare-advanced.js --restore` to undo both changes

The helper refuses to edit a dirty or untracked known test file in a git worktree. If it fails with
`Refusing to edit`, choose a clean selected test file, restore/stash the local change, or use the
manual Step 7b and Step 7c path with an explicit clean file.

Verbatim:

```bash
node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --auto
```

7b. Add one new deterministic passing test that is not present in
`dd-test-optimization-known-tests.json`.

For common Jest, Mocha, or Vitest files with simple `test(...)` or `it(...)` callback tests, use
`test-optimization-prepare-advanced.js --auto`; it prepares Step 7b and Step 7c together. The
helper reads `dd-test-optimization-known-tests.json` and
`dd-test-optimization-test-command.txt`, chooses the first known suite/test, creates a temporary
sibling EFD test, makes that known test fail once, and writes `dd-test-optimization-efd-command.txt`.
If `--auto` succeeds, skip the manual Step 7b and Step 7c edit instructions and continue to Step
7d. If `--auto` cannot infer a safe edit, use the explicit helper form or the manual Step 7b and
Step 7c instructions below.

The helper accepts the literal source-level test name from `test("name", ...)` or `it("name", ...)`;
it also accepts a suite-qualified analyzer name when exactly one source-level test name matches the
end. If the helper cannot match the known test, retry with the literal source-level name, then
continue with the manual Step 7b and Step 7c instructions if needed.

Adapt:

```bash
node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js \
  --framework jest \
  --efd-test-file FILL_IN_TEMP_TEST_FILE \
  --flaky-test-file FILL_IN_KNOWN_TEST_FILE \
  --flaky-test-name "FILL_IN_KNOWN_TEST_NAME" \
  --efd-command "FILL_IN_SECOND_TEST_COMMAND"
```

Replace `FILL_IN_TEMP_TEST_FILE`, `FILL_IN_KNOWN_TEST_FILE`, `FILL_IN_KNOWN_TEST_NAME`, and
`FILL_IN_SECOND_TEST_COMMAND` before running. For `FILL_IN_KNOWN_TEST_NAME`, prefer the exact
known-test name from `dd-test-optimization-known-tests.json`; use the literal source-level test
name if the helper reports that it cannot match the suite-qualified name. Use `--framework mocha`
or `--framework vitest` when that matches the selected command. The helper writes:

- `dd-test-optimization-efd-temp-test-file.txt`
- `dd-test-optimization-efd-test-name.txt`
- `dd-test-optimization-efd-new-test-snippet.txt`
- `dd-test-optimization-atr-flaky-test-file.txt`
- `dd-test-optimization-atr-flaky-test-backup.txt`
- `dd-test-optimization-atr-flaky-test-name.txt`
- `dd-test-optimization-atr-flaky-test-snippet.txt`
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

After creating a temporary sibling test file, write and verify its path:

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

7c. Make one already known test flaky for Auto Test Retries.

Adapt:

- Choose one test from `dd-test-optimization-known-tests.json` that the second command will run.
- Prefer a small, clean selected test file. Avoid user-modified files when a clean selected file
  exists.
- Save the original file to a backup under `dd-test-optimization-efd/backups/` before editing.
- Change the known test so the first execution throws and the retry passes.
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
same file and keep or restore any original assertions after the one-time failure branch.

Record the file and backup path before editing:

Adapt:

```bash
ATR_FLAKY_TEST_FILE='FILL_IN' # replace FILL_IN with the known test file to edit
if [ "$ATR_FLAKY_TEST_FILE" = 'FILL_IN' ] || [ -z "$ATR_FLAKY_TEST_FILE" ]; then
  echo "Replace FILL_IN with the known test file before continuing."
  exit 1
fi
test -f "$ATR_FLAKY_TEST_FILE"
ATR_BACKUP_DIR=dd-test-optimization-efd/backups
mkdir -p "$ATR_BACKUP_DIR"
ATR_FLAKY_BACKUP="$ATR_BACKUP_DIR/$(basename "$ATR_FLAKY_TEST_FILE").backup"
if [ -e "$ATR_FLAKY_BACKUP" ]; then
  echo "Auto Test Retries backup already exists: $ATR_FLAKY_BACKUP" >&2
  exit 1
fi
cp "$ATR_FLAKY_TEST_FILE" "$ATR_FLAKY_BACKUP"
printf '%s\n' "$ATR_FLAKY_TEST_FILE" > dd-test-optimization-atr-flaky-test-file.txt
printf '%s\n' "$ATR_FLAKY_BACKUP" > dd-test-optimization-atr-flaky-test-backup.txt
printf '%s\n' 'FILL_IN_KNOWN_TEST_NAME' > dd-test-optimization-atr-flaky-test-name.txt
if grep -q 'FILL_IN' dd-test-optimization-atr-flaky-test-name.txt; then
  echo "Replace FILL_IN_KNOWN_TEST_NAME with the known test name before continuing." >&2
  exit 1
fi
printf 'Auto Test Retries flaky test file: %s\n' "$ATR_FLAKY_TEST_FILE"
printf 'Auto Test Retries backup: %s\n' "$ATR_FLAKY_BACKUP"
```

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

7d. Run the second advanced run with known tests from the first run:

Required: use `--out-dir "$EFD_DIR"` to avoid overwriting root artifacts. It prevents the second
advanced run from overwriting the root wrapper artifacts and the first baseline artifacts.
Use the top-level loopback prerequisite if the wrapper fails with `listen EPERM 127.0.0.1`.

Verbatim:

```bash
set -e

EFD_DIR=dd-test-optimization-efd

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
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
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
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
node ./node_modules/dd-trace/ci/test-optimization-debug.js \
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

node -e '
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

node ./node_modules/dd-trace/ci/test-optimization-prepare-advanced.js --restore
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
selected subset. The restore command removes the helper-created EFD test file and restores the
helper-edited flaky test file even when validation fails. After helper restore succeeds, the manual
cleanup blocks below should be no-ops. Run them only to verify no recorded temporary state remains,
or when Step 7b/7c used manual edits instead of the helper.

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

Restore and verify the known test file changed for Auto Test Retries:

Verbatim:

```bash
if [ -f dd-test-optimization-atr-flaky-test-file.txt ]; then
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
test identity.

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
2. Run a baseline command with `DD_TEST_OPTIMIZATION_TM_BASELINE=1` so the generated test passes
   and the intake captures the exact emitted identity.
3. Build the Test Management properties response from the baseline artifact.
4. Run the generated test again with the matching `tm-*` settings mode and the calibrated response.
5. Restore generated source and marker files before moving to the next subcheck.

8a. Fill one subcheck plan.

Adapt:

```bash
TM_MODE='FILL_IN' # disabled, quarantined, or attempt-to-fix
TM_SETTINGS_MODE='FILL_IN' # tm-disabled, tm-quarantined, or tm-attempt-to-fix
TM_FRAMEWORK='FILL_IN' # mocha, jest, or vitest when using the helper
TM_TEST_FILE='FILL_IN' # generated file path, for example: test/dd-trace-tm-disabled.spec.js
TM_TEST_COMMAND='FILL_IN' # command that runs only the generated file

if [ "$TM_MODE" = 'FILL_IN' ] || [ "$TM_SETTINGS_MODE" = 'FILL_IN' ] || \
  [ "$TM_FRAMEWORK" = 'FILL_IN' ] || [ "$TM_TEST_FILE" = 'FILL_IN' ] || \
  [ "$TM_TEST_COMMAND" = 'FILL_IN' ]; then
  echo "Replace every FILL_IN value before continuing." >&2
  exit 1
fi

printf '%s\n' "$TM_TEST_COMMAND" > "dd-test-optimization-tm-${TM_MODE}-command.txt"
printf '%s\n' "$TM_MODE" > dd-test-optimization-tm-mode.txt
printf '%s\n' "$TM_SETTINGS_MODE" > dd-test-optimization-tm-settings-mode.txt
printf '%s\n' "$TM_FRAMEWORK" > dd-test-optimization-tm-framework.txt
printf '%s\n' "$TM_TEST_FILE" > dd-test-optimization-tm-test-file.txt
printf '%s\n' "$TM_TEST_COMMAND" > dd-test-optimization-tm-test-command.txt
export TM_MODE TM_SETTINGS_MODE TM_FRAMEWORK TM_TEST_FILE TM_TEST_COMMAND
```

Command selection rules:

- Prefer a generated sibling test file under the same directory as the selected basic-reporting test.
- Prefer `npm test -- "$TM_TEST_FILE"` when `scripts.test` is a direct runner command that accepts
  file arguments.
- Use `./node_modules/.bin/<runner> "$TM_TEST_FILE"` when `scripts.test` is absent or cannot accept
  a direct file argument.
- Do not edit an existing customer test for these subchecks unless generated tests cannot work.

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
  node ./node_modules/dd-trace/ci/test-optimization-prepare-test-management.js --restore >/dev/null 2>&1 || true
}
trap cleanup_tm EXIT

node ./node_modules/dd-trace/ci/test-optimization-prepare-test-management.js \
  --create \
  --mode "$TM_MODE" \
  --framework "$TM_FRAMEWORK" \
  --test-file "$TM_TEST_FILE"

TM_BASELINE_DIR="dd-test-optimization-tm-${TM_MODE}-baseline"
TM_RESULT_DIR="dd-test-optimization-tm-${TM_MODE}"
TM_BASELINE_COMMAND="DD_TEST_OPTIMIZATION_TM_BASELINE=1 $TM_TEST_COMMAND"

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command "$TM_BASELINE_COMMAND" \
  --settings-mode basic-reporting \
  --out-dir "$TM_BASELINE_DIR" \
  --no-open

node ./node_modules/dd-trace/ci/test-optimization-prepare-test-management.js \
  --response \
  --mode "$TM_MODE" \
  --baseline-intake "$TM_BASELINE_DIR/dd-test-optimization-intake.json" \
  --out "$TM_RESULT_DIR/test-management-tests.json" \
  --identity-out "$TM_RESULT_DIR/test-management-identity.json"

node ./node_modules/dd-trace/ci/test-optimization-debug.js \
  --test-command "$TM_TEST_COMMAND" \
  --settings-mode "$TM_SETTINGS_MODE" \
  --test-management-tests "$TM_RESULT_DIR/test-management-tests.json" \
  --out-dir "$TM_RESULT_DIR" \
  --no-open

export TM_MODE

node -e '
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

node ./node_modules/dd-trace/ci/test-optimization-prepare-test-management.js --restore
trap - EXIT
```

Do not hand-write the Test Management identity. The helper reads the framework, suite, and test
name from the baseline intake artifact and writes the response expected by
`/api/v2/test/libraries/test-management/tests`.

If baseline calibration, the managed run, or validation fails, the `EXIT` trap still runs the helper
restore. After any failure, run the restore command again and report whether cleanup succeeded:

```bash
node ./node_modules/dd-trace/ci/test-optimization-prepare-test-management.js --restore
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
reporting result and use `dd-test-optimization-final-report.txt` for the required validation paths
and artifact paths. The root compact summary describes only the root/basic wrapper run. After Step
7, advanced EFD and Auto Test Retries status must come from the Step 9 extractor or
`dd-test-optimization-efd/dd-test-optimization-final-report.txt`, not from the root compact
summary. If manual Steps 3-6 were used, include the Step 6c stdout report or the compact summary,
then copy the required validation path lines from the final report. Do not `cat`
`dd-test-optimization-final-report.txt` after Step 6c; that duplicates the same report. Add notable
weird cases not represented in the generated report only when needed.

Report static warnings and errors from the initial root `dd-test-optimization-static.json`. If the
wrapper is run without Step 1, use the wrapper-generated root `dd-test-optimization-static.json`.
Do not switch to `dd-test-optimization-basic/dd-test-optimization-static.json` or
`dd-test-optimization-efd/dd-test-optimization-static.json` unless the difference is the notable
case being reported.

Use this extractor to assemble the required fields from the root and advanced-check artifacts:

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

const tmDisabledExit = readText("dd-test-optimization-tm-disabled/dd-test-optimization-test-exit-code.txt", "n/a")
const tmQuarantinedExit = readText("dd-test-optimization-tm-quarantined/dd-test-optimization-test-exit-code.txt", "n/a")
const tmAttemptToFixExit = readText("dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-test-exit-code.txt", "n/a")

console.log(`HTML report: ${readText("dd-intake-html-file-url.txt", readFinalReportLine("HTML report:"))}`)
console.log(`HTML report path: ${readText("dd-intake-html-path.txt", readFinalReportLine("HTML report path:"))}`)
console.log(`Datadog validation: ${readFinalReportLine("Datadog validation:")}`)
console.log(`Advanced Datadog validation: ${readReportLine("dd-test-optimization-efd/dd-test-optimization-final-report.txt", "Datadog validation:")}`)
console.log(`Final report path: ${process.cwd()}/dd-test-optimization-final-report.txt`)
console.log(`Compact summary path: ${process.cwd()}/dd-test-optimization-summary.txt`)
console.log(`Feedback summary path: ${process.cwd()}/dd-test-optimization-feedback-summary.txt`)
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
console.log(`Test Management disabled validation: ${readReportLine("dd-test-optimization-tm-disabled/dd-test-optimization-final-report.txt", "Datadog validation:")}`)
console.log(`Test Management disabled status: ${getTmStatus(tmDisabled, tmDisabledExit, "disabled", "0")}`)
console.log(`Test Management disabled identities: ${getTmLine(tmDisabled, "disabled", "identities")}`)
console.log(`Test Management disabled exit code: ${tmDisabledExit}`)
console.log(`Test Management quarantined validation: ${readReportLine("dd-test-optimization-tm-quarantined/dd-test-optimization-final-report.txt", "Datadog validation:")}`)
console.log(`Test Management quarantined status: ${getTmStatus(tmQuarantined, tmQuarantinedExit, "quarantined", "0")}`)
console.log(`Test Management quarantined identities: ${getTmLine(tmQuarantined, "quarantined", "identities")}`)
console.log(`Test Management quarantined exit code: ${tmQuarantinedExit}`)
console.log(`Test Management attempt-to-fix validation: ${readReportLine("dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-final-report.txt", "Datadog validation:")}`)
console.log(`Test Management attempt-to-fix status: ${getTmStatus(tmAttemptToFix, tmAttemptToFixExit, "attemptToFix", "non-zero")}`)
console.log(`Test Management attempt-to-fix identities: ${getTmLine(tmAttemptToFix, "attemptToFix", "identities")}`)
console.log(`Test Management attempt-to-fix retry reasons: ${getTmLine(tmAttemptToFix, "attemptToFix", "observedRetryReasons")}`)
console.log(`Test Management attempt-to-fix exit code: ${tmAttemptToFixExit}`)
console.log(`Static warnings/errors: ${staticFindings.join("; ") || "none"}`)
'
```

Frameworks can report test names with nested suite or `describe` text already included. Repeated
words in `EFD retried new test names` are not automatically malformed; compare them with the
selected temporary test's suite and test names.

The final response must include:

- HTML report `file://` URL and absolute path.
- Datadog validation relative path.
- Advanced Datadog validation relative path when Step 7 ran.
- Test Management validation relative paths when Step 8 ran.
- Final report path and compact summary path.
- Feedback summary path when the feedback extractor was run.
- Selected test command and test result.
- EFD check result when Step 7 ran, including known tests count, retried new test execution count,
  distinct retried new test name count, and EFD execution diagnosis.
- Auto Test Retries check result when Step 7 ran, including failing executions, passing
  executions, and passing retry executions.
- Test Management disabled, quarantined, and attempt-to-fix results when Step 8 ran.
- The diagnostic question answers with each question text inline.
- Static warnings and errors.
- Recommended next actions.
- Cleanup confirmation for any temporary EFD test file and Auto Test Retries edit.

Reference-only feedback extractor: use Step 2 and Step 3 in `Runbook Feedback Mode: Exact Path`
for feedback-mode execution. This section is retained only to show the equivalent
renderer command near the customer-facing Step 9 material. Do not run it after the top-level F9
block has already been run.

Write actionable feedback text before running the extractor. Use `No actionable feedback.` when
there is no actionable feedback. The default command below only writes the default text when the
feedback file does not already exist or is empty.

Verbatim:

```bash
if [ ! -s dd-test-optimization-actionable-feedback.txt ]; then
  printf '%s\n' 'No actionable feedback.' > dd-test-optimization-actionable-feedback.txt
fi

node ./node_modules/dd-trace/ci/test-optimization-feedback-summary.js
```

Compact feedback response shape:

```text
Runbook completed: {yes | no, explain}
Diagnostic outcome: {basic reporting worked | basic reporting did not work | runbook failed, explain}
Basic reporting: {stage}, requests={count}, event levels={summary}, decode errors={count}
EFD: {passed | failed | skipped: reason | not run}, known tests={count}, retried new tests={retry execution count}, distinct retried names={count}
Auto Test Retries: {passed | failed | skipped: reason | not run}, failed={count}, passed={count}, retry passes={count}
Reports: {HTML file URL}, {final report path}, {compact summary path}
Cleanup: {temporary EFD removed/restored status}, {flaky edit restored status}. Diagnostic artifacts intentionally remain untracked until the next Step 0 cleanup.
Actionable feedback:
- {feedback or "No actionable feedback."}
Pre-existing worktree changes:
{non-diagnostic status lines or "none"}
Current diagnostic artifacts:
{diagnostic artifact status lines or "none"}
```

Final response template:

```text
HTML report: file:///absolute/path/to/dd-test-optimization-report.html
HTML report path: /absolute/path/to/dd-test-optimization-report.html
Datadog validation: ci/test/validation#pako:{payload}
Advanced Datadog validation: ci/test/validation#pako:{payload}
Test Management disabled validation: ci/test/validation#pako:{payload}
Test Management quarantined validation: ci/test/validation#pako:{payload}
Test Management attempt-to-fix validation: ci/test/validation#pako:{payload}
Final report path: /absolute/path/to/dd-test-optimization-final-report.txt
Compact summary path: /absolute/path/to/dd-test-optimization-summary.txt
Feedback summary path: /absolute/path/to/dd-test-optimization-feedback-summary.txt

Selected test command:
{command}

Advanced test command:
{command}

Test result:
{one-line result}

Basic reporting:
Primary stage: {stage}
Requests: {count}
Event levels: sessions={count}, modules={count}, suites={count}, tests={count}
Decode errors: {count}

EFD check:
Status: {not run | skipped: reason | passed | failed}
Known tests received: {count}
Retried new tests: {count}
Distinct retried new test names: {count}
Retried new test names: {names or none}

Auto Test Retries check:
Status: {not run | skipped: reason | passed | failed}
Failed executions: {count}
Passed executions: {count}
Passing retry executions: {count}
Flaky tests reported: {count}
Flaky test names: {names or none}

Test Management check:
Disabled status: {not run | skipped: reason | passed | failed}
Disabled identities: {identities or none}
Disabled exit code: {code}
Quarantined status: {not run | skipped: reason | passed | failed}
Quarantined identities: {identities or none}
Quarantined exit code: {code}
Attempt-to-fix status: {not run | skipped: reason | passed | failed}
Attempt-to-fix identities: {identities or none}
Attempt-to-fix retry reasons: {reasons or none}
Attempt-to-fix exit code: {code}

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

Notable execution cases:
- {only include if needed}

Cleanup confirmation:
- Temporary EFD test removed: {yes | not created | no, explain}
- Temporary Auto Test Retries edit restored: {yes | not created | no, explain}
- Temporary Test Management tests removed: {yes | not created | no, explain}
- Temporary Test Management marker files removed: {yes | not created | no, explain}
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
