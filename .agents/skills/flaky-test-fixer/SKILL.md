---
name: flaky-test-fixer
description: |
  This skill should be used when the user asks to "fix a flaky test", "fix this flake",
  "investigate flakiness", "investigate this flake", "look at the flakiness report",
  "fix flaky CI", "this test is flaky", "test fails intermittently",
  "test passes locally but fails on CI", "test fails sometimes", "test is unstable",
  "intermittent test failure", "intermittent CI failure", "CI keeps failing",
  "look into this CI failure", "investigate this CI job",
  "EADDRINUSE in tests", "OverwriteModelError", "ambiguous_timeout",
  "test timing out", "before hook timeout", "beforeEach hook timeout",
  "this.timeout() not working", "arrow function timeout",
  "traces[0][0] failing", "wrong span", "span order race",
  "race condition in test", "test order dependency", "test pollution",
  "wall clock vs monotonic", "sampling test failing", "fixed sleep",
  or hands off any CI workflow link / GitHub Actions failure / flakiness report
  that points at an intermittent test in dd-trace-js. Treat any test failure that
  the user calls "flaky", "intermittent", or "sometimes" as in-scope, even when
  they don't name the skill — the goal is to turn a flaky test into a draft PR
  that fixes the root cause with the rigor a careful maintainer would apply by hand.
---

# Flaky Test Fixer

## Core principle

**A flake is a bug.** If a test fails intermittently, something real is wrong — usually a race, a shared resource, or an unbounded timing assumption. The job is to find that bug and fix it, not to make the symptom go away.

Mitigations like `it.retries(3)`, `--retries 1`, "increase the timeout", or `it.skip` may *hide* the flake without removing it, and they shift the cost onto every future engineer who hits the same code. Reach for them only when you have first shown that no structural fix exists, and call that out explicitly in the PR.

The end goal of this skill is to take a single flaky test and produce a **draft PR** that:

1. Reproduces the flake locally (or explains precisely why it can't be reproduced).
2. Identifies the structural cause.
3. Applies the smallest fix that eliminates that cause.
4. Demonstrates that the fix works (and, for newly added tests, that it catches the bug it claims to catch).
5. Stays scoped to that one cause — no drive-by changes.

## Workflow

Follow these phases in order. Resist the urge to skip ahead to "apply fix" before the cause is mechanistic.

### 1. Frame the failure from real evidence

Start from the actual CI artifact, not from anecdote. The user will usually hand you one of:

- A GitHub Actions run / job URL → `gh api /repos/DataDog/dd-trace-js/actions/jobs/<id>/logs` to read the raw log.
- A PR comment with a failure stack trace.
- A flakiness report (occurrence counts per test).

Capture:

- The exact failing assertion or error message — and whether it's actually a test failure or a step failure (Docker pull, OIDC token, action setup). Both are in scope; they have different fixes (see Phase 4).
- The platform / Node version / Plugin / OS the failure occurred on. Single-platform failures are usually the most informative — if every other Node version passes and only Node 26 fails, the cause is almost certainly version-specific.
- How frequently it fails (one in N runs, or only on `master`, or only on Node 24, etc).
- Any test that runs **before** the failing test in the same job — order-dependence is a common cause.

**Check first whether this is already being fixed.** Before reproducing, before diagnosing, spend 30 seconds on:

```bash
# Recent commits touching the failing file
git log --oneline -10 -- <path/to/failing.spec.js>
# Open and recently-merged PRs mentioning the symptom
gh pr list --repo DataDog/dd-trace-js --state all --search "<test name or error keyword>" --limit 10
# Active branches touching the file (in case work is in progress)
git branch -r --contains $(git log -1 --format=%H -- <path>) | head
```

A flakiness report can be hours or days old; the fix may already be merged. If you find a PR that addresses this symptom, surface it to the user with the PR number and the date it landed — don't open a duplicate, and don't start re-diagnosing what's already shipped.

If the user hands over a report covering multiple tests, **work one root cause at a time, in occurrence order.** Each cause becomes its own draft PR — but related infrastructure failures (e.g. five jobs all failing on Docker Hub timeouts) can share a single PR when the fix is to the shared CI plumbing they all run through. The principle is *one cause, one PR*, not *one job, one PR*.

### 2. Reproduce locally

A reliable local repro is the difference between a confident fix and a guess. Make a serious attempt before moving on.

**Always unset OTEL exporters before running tests** that assert on spans — Claude Code, Cursor, and other DD-instrumented terminals export traces via OTLP, which bypasses the test agent and causes every span assertion to silently time out:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
```

**Plugin tests** (anything under `packages/datadog-plugin-*/test/`):

```bash
PLUGINS="<name>" npm run test:plugins
# or narrow to one spec:
SPEC="packages/datadog-plugin-<name>/test/index.spec.js" PLUGINS="<name>" npm run test:plugins
# direct:
./node_modules/.bin/mocha packages/datadog-plugin-<name>/test/index.spec.js --grep "<pattern>"
```

**Integration tests** (`integration-tests/`):

```bash
./node_modules/.bin/mocha --timeout 60000 integration-tests/<area>/<file>.spec.js
```

**Unit tests** (general):

```bash
./node_modules/.bin/mocha <path/to/file>.spec.js --grep "<pattern>"
```

**Looping to surface the flake.** Many flakes only show up 1 in 20-50 runs. Loop until failure to get a reliable signal:

```bash
for i in $(seq 1 50); do
  echo "=== run $i ==="
  ./node_modules/.bin/mocha <path> --grep "<pattern>" || { echo "FAILED on run $i"; break; }
done
```

For tests that need external services (Kafka, Redis, Couchbase, etc.) check `docker compose up -d <service>` per `.github/workflows/apm-integrations.yml`.

If the flake genuinely will not reproduce locally (CI-only races against external dependencies, Xvfb/display-related, ARM64 vs x86), say so explicitly and pivot to log-driven diagnosis — but be skeptical of "can't reproduce" as a stopping condition. Often a small loop, a slower machine, or rate-limiting CPU is enough.

### 3. Diagnose the structural cause

The defining move here is **refusing to stop at the first plausible explanation.** Apply these questions until the answer is mechanistic:

- *Why does it not always fail?* What invariant holds in the passing cases? What is different in the failing cases?
- *Is the cause timing or structural?* A timing answer ("CI was slow") is usually a hint that something is racing — find the race.
- *What state leaks between runs?* Modules cached in `require.resolve`, mongoose model registries, open sockets, listening ports, `process` event listeners, mocked clocks, registered DC subscribers.
- *Does the test depend on the order of asynchronous events* (e.g. span batches, event handlers registering, finalizers running)?
- *Is there an arrow function in a `describe` / `before` / `beforeEach`?* Arrow functions don't bind `this`, so `this.timeout(N)` silently no-ops and the hook keeps the default 5000ms. This is a known footgun in this repo.

If `MOCHA_OPTIONS=--retries 1` is active on `master`, a transient first-run failure followed by an auto-retry can surface **state-leak bugs** (e.g. the mongoose `OverwriteModelError`) that don't appear on PR branches. Account for this when reading CI logs — the immediate symptom may be a downstream effect, not the original race.

When in doubt, read [references/diagnosis-questions.md](references/diagnosis-questions.md) for a longer interrogation checklist.

### 4. Apply the structural fix

Once the cause is known, pick the fix that eliminates the race rather than makes it less likely. The catalog in [references/patterns.md](references/patterns.md) covers the shapes that recur in this repo. The quick index:

| Symptom / shape | Canonical fix |
|---|---|
| `traces[0][0]` checks the wrong span when batches arrive in mixed order | Filter the batch with `.find(t => t[0].name === '<expected>')`, throw inside `assertSomeTraces` so it retries on the next batch |
| `EADDRINUSE` or port-reuse races in server tests | Listen on `port: 0`, capture `server.address().port` after `listening` event |
| `before`/`beforeEach` timing out at 5000ms despite `this.timeout(N)` | Convert the arrow function to a regular `function () { ... }` so `this` binds |
| Fixed `setTimeout` / fixed retry count to wait for an async condition | Bounded polling loop that exits as soon as the condition holds |
| Wall-clock vs monotonic clock skew in timing assertions | Widen tolerance with a comment explaining the clock-source mismatch; include the actual measured value in the assertion message |
| Combined `afterEach` callback — one failure skips remaining cleanup | Split into one hook per concern; each cleanup gets its own `afterEach` |
| `OverwriteModelError` / "X already defined" on Mocha auto-retry | Make registration idempotent (`mongoose.models.X ?? mongoose.model('X', schema)`) |
| Handler registration race — first request fires before subscribe is live | Add a `before` hook that issues a warmup request and awaits drain |
| Service readiness race (Couchbase, Kafka, etc.) | Poll the *exact* service the tests use, not a sibling port; readiness != reachable |
| External daemon startup race (Xvfb, browser drivers) | `until <readiness-check>; do sleep 0.1; done` before launching tests |
| Non-deterministic source (e.g. `Math.random()` driving a sampling test) | Inject the random function so the test can pin it; remove the non-determinism, don't relax the threshold |
| External-service step failure in CI (Docker Hub pull timeout, OIDC token fetch, package registry unavailability) | Workflow-level retry/backoff, registry mirror, digest pinning, or split the dependency out — see [patterns.md §13](references/patterns.md) |

For each shape, [references/patterns.md](references/patterns.md) has the full before/after with a real PR citation.

**Scope discipline.** Only change the lines required to fix the one cause you identified. Resist the urge to also rename a variable, increase an unrelated timeout, switch to `assert.deepStrictEqual`, or "while we're here". Those are separate PRs.

### 5. Verify the fix

Before you propose the fix as done:

1. **Confirm the test fails without the fix.** Stash or revert the fix locally, rerun the failing test (in a loop if needed), confirm the original failure mode reproduces. For *newly added* tests this is non-negotiable — a test that passes both with and without the bug being present is not a test.
2. **Confirm the test passes with the fix.** Single run.
3. **Confirm the fix is stable.** Loop 20-50 times. The flake should be gone, not "less frequent."
4. **Run the whole spec file**, not just the grep-narrowed case, to confirm you didn't break siblings.
5. For plugin tests, run `PLUGINS="<name>" npm run test:plugins` so the test agent assertions are exercised.

If you have to settle for a mitigation (timeout widened, retry added), document *why* a structural fix wasn't possible and what would be needed to remove the mitigation later. Be specific.

### 6. Open a draft PR

See [references/pr-workflow.md](references/pr-workflow.md) for the full PR workflow with templates. The shape:

- Branch: `<your-prefix>/fix-<area>-<short-symptom>` using whatever prefix you normally use for branches in this repo (e.g. your GitHub handle), so the branch is `<handle>/fix-http2-port-reuse`.
- Commit message follows Conventional Commits.
  - `test(<scope>):` for changes scoped to `test/` and `integration-tests/`.
  - `fix(<scope>):` when production code under `src/` changes (even if the cause was infrastructural).
  - `ci(<scope>):` for `.github/workflows/`, Docker, or service-readiness scripts.
- One commit per logical change (don't squash unrelated fixes).
- PR opened as **draft** (`gh pr create --draft`).
- PR body has `## Summary` (bullets, one per change with *why*) + `## Test plan` (checklist of validation steps), and ends with the Claude Code attribution. **Do not include a `## Semver` section.**

**Always ask before committing or pushing.** Confirm the staged diff with the user before any `git commit`, and confirm the commit before any `git push`, at every step of the PR — including PRs that are already open. A flake fix is small and easy to review, but a wrong fix that lands silently is expensive to undo.

## Anti-patterns to refuse or push back on

When proposing a fix — or when the user suggests one — push back if it falls into any of these categories. The job is to surface them with a short explanation, not to silently accept.

- **"Just add `it.retries(N)`."** Default position: retries hide bugs and pass the cost to every future contributor. *But* this rule is context-sensitive — when the sibling tests in the same `describe` block already carry `.retries(N)` for the same class of inherent unreliability (OOM timing across V8 versions, GC nondeterminism, network jitter inside a sandbox), adding retries to a newly-flaky sibling is consistency with the file's existing acknowledgment that this test class is genuinely unreliable. The signal isn't "is `.retries()` used" — it's "*do the surrounding tests already use it for this same reason*." When you do add retries: hoist or extend the comment that explains *why* this class of tests needs them, and call out the version/condition that triggered the new sibling to need the same treatment (e.g. "Node 26's V8 crashes faster on near-OOM"). PR #8742 is the canonical example.
- **"Increase the timeout."** Acceptable only after the structural race is gone *and* you need headroom for legitimate slow CI. The PR body should say "the race is fixed; this is margin." If the test still depends on the timeout to pass, the race isn't fixed.
- **"Add a `setTimeout` / `sleep` to give it time."** Fixed sleeps are flaky by construction. Replace with a polling loop that exits on success, with a generous bound for the worst case.
- **"Mock the thing causing the flake."** Especially for runtime / bundler / external-service tests. The flake usually surfaces a real integration bug. Prefer real integration; if mocking is the only option, the PR must say so and explain why.
- **"Mark it `.skip` / `.pending` for now."** Almost always wrong unless the test itself is invalid. Even then, prefer deleting the test over disabling it.
- **"Bundle the timeout bumps for the other files in this PR while we're here."** No. One cause per PR. Open separate PRs for separate causes, even if the fix is identical.
- **"`traces[0][0]` is the first span — that's what we want."** Only when the test explicitly arranges a single trace with a single span. When batches mix client/server spans or finish out of order, filter by name.
- **"Looking at the test, I think this is environmental."** Reject without evidence. If it happens in CI, it can be made to happen locally or in a controlled environment most of the time. Push past "environmental" to a mechanism. *Genuinely* environmental failures (Docker Hub, OIDC, package registry) are still in scope — the fix lives in CI plumbing rather than test code (see [patterns.md §13](references/patterns.md)).
- **"Just rerun the failed job."** A team-wide habit that turns into a tax. If a step fails once a week and the team's response is to click "Re-run failed jobs", the cost is paid every time. Three retries with backoff in the workflow file pays once and is shared by everyone.

When the user pushes back on your proposal with "are you sure?" or "wouldn't it still ...?", treat that as a signal that the fix is mitigating, not eliminating. Reopen the analysis.

## Reference files

- **[Pattern catalog](references/patterns.md)** — Full code examples for each flake shape, keyed by the PR that introduced the fix in this repo. Read this when you have identified the shape and need the canonical implementation.
- **[Diagnosis questions](references/diagnosis-questions.md)** — Longer interrogation checklist for stubborn flakes; categorised by hypothesis (timing, state, concurrency, environment).
- **[PR workflow](references/pr-workflow.md)** — Branch naming, commit message templates, PR body templates, the commit/push checkpoint protocol, and conventions specific to this repo (no Semver section, Claude Code attribution, draft-by-default).
