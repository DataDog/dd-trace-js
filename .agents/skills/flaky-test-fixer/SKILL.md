---
name: flaky-test-fixer
description: >-
  Use when triaging, investigating, or fixing a suspected flaky test, intermittent
  failure, nondeterministic CI failure, timing race, or test-order dependency in
  dd-trace-js. Classifies infrastructure and deterministic failures before the
  root-cause workflow.
---

# Flaky test fixer

## Classify once

Spend one evidence pass on the failing step, the first actionable error, and whether the test process started. Do
not reproduce or search test code before this gate.

- **Infrastructure:** the test process never ran because checkout, runner, registry, network, or credentials failed,
  or independent evidence proves an externally owned network or service outage regardless of test-entry timing. State
  the evidence and stop; ignore it for flaky-test work. Treat recurrence as a separate CI task only when asked.
- **Deterministic:** the same revision and inputs consistently fail because of a version, fixture, configuration, or
  assertion mismatch. It is not a flake; handle it in the owning change.
- **Genuine flake:** the same test can pass and fail at the same revision with matching relevant inputs and execution
  configuration, or evidence proves nondeterministic ordering, timing, or shared state. A green rerun is evidence only
  when the test ran under those matching conditions in both attempts.
- **Unknown:** evidence proves none of the above. Run one targeted reproduction or history comparison; do not promote
  uncertainty to “flaky,” “infrastructure,” or “unrelated.”

## Fix the cause

1. Reproduce through the smallest real test entry point. Stress the suspected boundary and expose ordering or state;
  repeated reruns without a sharper hypothesis are not diagnosis. For a hang, inspect the last error before the
  leaked handle kept the process alive.
2. Write one mechanistic sentence naming the producer, consumer, state or event, and invalid ordering or lifetime.
  It must explain both the pass and failure. Do not design a fix before this sentence holds.
3. Before editing, search the repository for every test with the same violated invariant and lifecycle owner.
  Inventory, count, and list each member and exclusion; state the shared failure mechanism and lifecycle or
  completion owner. A range is not an enumeration. Callback versus promise does not split a cohort; similar syntax
  under a different contract does not join it.
4. Design the proof, then trace success, error, retry, cleanup, and concurrent paths. Fix the narrowest canonical
  owner that restores the invariant for the whole cohort without a new public/test-only surface or production work
  added solely for tests.
5. Apply that fix to the complete cohort. Do not substitute retries, skips, sleeps, timeout/tolerance increases,
  filtered assertions, or broader mocks for a cause. Keep unrelated mechanisms in separate changes.
6. Verify the original failure without the fix or with a deterministic regression when practical. List every changed
  sibling individually in the verification plan, then run them, a targeted repeat or stress run, the complete specs,
  and the required coverage/lint from `AGENTS.md`. Report commands, iteration counts, and unproved claims.
