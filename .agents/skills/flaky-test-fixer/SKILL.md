---
name: flaky-test-fixer
description: >-
  Use when classifying, investigating, or fixing a suspected flaky test, intermittent test result, nondeterministic
  CI test failure, timing race, hang, or test-order dependency in dd-trace-js. Classifies infrastructure and
  deterministic failures before reproduction or code search.
---

# Flaky test fixer

Establish whether a failure is caused by the current change, deterministic, infrastructure, or genuinely flaky.
“Flaky”, “pre-existing”, and “unrelated” are conclusions that require evidence.
Treat a failure on the current change as caused by that change until evidence identifies another mechanism;
otherwise call it unknown.

Never make CI green by weakening or deleting assertions, filtering unexpected inputs, increasing timeouts, or adding
unexplained retries.

## Classify once

Spend one evidence pass on the exact failing command, test name, assertion or error, environment, first actionable
error, last meaningful log line, whether the test process started, and the current diff. Do not reproduce or search
test code before this gate.

- **Infrastructure:** the test process never ran because checkout, runner, registry, network, or credentials failed,
  or independent evidence proves an externally owned network or service outage regardless of test-entry timing. State
  the evidence and stop; ignore it for flaky-test work. Treat recurrence as a separate CI task only when asked.
- **Deterministic:** the same revision and inputs consistently fail because of a version, fixture, configuration, or
  assertion mismatch. It is not a flake; handle it in the owning change when related.
- **Genuine flake:** the same test can pass and fail at the same revision with matching relevant inputs and execution
  configuration, or evidence proves nondeterministic ordering, timing, or shared state. A green rerun is evidence only
  when the test ran under those matching conditions in both attempts.
- **Unknown:** evidence proves none of the above. Run one targeted reproduction or history comparison after this gate;
  do not promote uncertainty to “flaky”, “infrastructure”, or “unrelated”.

Evidence for an unrelated flake can include a passing rerun plus a credible race mechanism, the same failure on the
unchanged target branch, a tracked known-flake entry, or a reproducible ordering or resource-contention dependency. A
passing rerun by itself is evidence of nondeterminism, not proof that the current change is unrelated.

## Investigate and fix the cause

1. Re-read the current diff and state a one-line candidate mechanism: “X fails because Y causes Z.” Reproduce
   through the smallest real test entry point, preserving relevant environment variables and services. Stress a
   suspected boundary or use focused repeated runs only when testing a concrete nondeterminism hypothesis. When safe
   and practical, compare against the unchanged target branch in an isolated worktree or equivalent clean
   environment. Use the actual target branch for backports, not automatically `master`.
2. Write one mechanistic sentence naming the producer, consumer, state or event, and invalid ordering or lifetime. It
   must explain both the pass and failure for a flake. Do not design a fix before this sentence holds.
3. Before editing, search for every test with the same violated invariant and lifecycle owner. Inventory, count, and
   list each member and exclusion; state the shared failure mechanism and lifecycle or completion owner. A range is
   not an enumeration. Callback versus promise does not split a cohort; similar syntax under a different contract
   does not join it.
4. Design the proof, then trace success, error, retry, cleanup, and concurrent paths. Fix the narrowest canonical
   owner that restores the invariant for the whole cohort without a new public or test-only surface or production
   work added solely for tests.
5. Apply the fix to the complete cohort. Stop stray requests, close leaked resources, restore hooks, and remove shared
   mutable state. Use fake timers instead of real-time waits, proper resource allocation instead of arbitrary delays,
   and lifecycle ownership instead of forced ordering. Do not substitute retries, skips, sleeps, timeout or tolerance
   increases, filtered assertions, or broader mocks for a cause. Keep unrelated mechanisms in separate changes.
6. Verify the original failure without the fix or with a deterministic regression when practical. List every changed
   sibling individually in the verification plan, then run them, a targeted repeat or stress run, the complete specs,
   and the required coverage and lint from `AGENTS.md`. Report commands, iteration counts, and unproved claims.

## Hung jobs

Treat a hang as a potentially masked failure. Inspect the last meaningful error and leaked handles such as tracer or
remote-configuration timers, sockets, child processes, servers, and unfinished hooks before considering a timeout
increase.

## Parallel investigation

After the classification gate, when a suspected unrelated flake appears during another task, delegate its
investigation immediately if sub-agents are available and the investigation has a disjoint write scope. Continue the
main task while it runs.

Give the sub-agent:

- The exact command and failing output
- The current change summary and why the failure may be unrelated
- Relevant paths, services, runtime version, and environment variables
- A classification-first, then read-and-reproduce mandate
- A request for reproduction rate, mechanism, evidence, and the smallest proposed fix

Do not duplicate the sub-agent's investigation in the main thread or let it modify files also being changed there.

A separate branch, commit, or draft PR requires explicit user authorization. When authorized, isolate a genuine
unrelated flake fix from the feature change and base it on the appropriate clean target branch. If a confirmed
unrelated flake cannot be fixed immediately, a temporary skip is not a fix and requires a tracked reason in its own
authorized change; never silently weaken an assertion.

## Report

Report:

1. Classification: caused by the current change, deterministic pre-existing defect, genuine unrelated flake,
   infrastructure, or unknown
2. Reproduction command and observed frequency
3. Evidence and one-line mechanism
4. Root-cause fix or next investigation step
5. Whether a separate tracked change is required
