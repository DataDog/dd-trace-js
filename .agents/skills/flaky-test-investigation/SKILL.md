---
name: flaky-test-investigation
description: |
  Use when a dd-trace-js test or CI job fails intermittently or is suspected to be unrelated to the current change.
  Triggers: flaky test, intermittent CI failure, passing rerun, timeout, test ordering, port race, duplicate spy call,
  leaked handle, hung job, nondeterministic failure, investigate in a sub-agent, separate flaky-test fix.
---

# Flaky Test Investigation

Use this skill to establish whether a failure is deterministic, caused by the current change, or genuinely unrelated
and nondeterministic. “Flaky”, “pre-existing”, and “unrelated” are conclusions that require evidence.

## Initial Position

Treat a failure on the current change as caused by that change until evidence identifies another mechanism. “Unknown,
investigating” is the correct label when the mechanism is not yet understood.

Never make CI green by weakening or deleting assertions, filtering unexpected inputs, increasing timeouts, or adding
unexplained retries.

## Triage

1. Capture the exact failing command, test name, assertion/error, environment, and last meaningful log line.
2. Re-read the current diff and state a one-line candidate mechanism: “X fails because Y causes Z.”
3. Reproduce with the narrowest equivalent command. Preserve relevant environment variables and services.
4. Check deterministic sibling cases by searching for the same stale path, renamed key, version check, fixture shape,
   resource lifecycle, or timing pattern.
5. Use focused repeated runs only when they test a concrete nondeterminism hypothesis; do not loop blindly.
6. When safe and practical, compare against the unchanged target branch in an isolated worktree or equivalent clean
   environment. Use `master` for work based on `master`, not automatically for a backport branch.

Evidence for an unrelated flake can include a passing rerun plus a credible race mechanism, the same failure on the
unchanged target branch, a tracked known-flake entry, or a reproducible ordering/resource-contention dependency. A
passing rerun by
itself is evidence of nondeterminism, not proof that the current change is unrelated.

## Parallel Sub-Agent Workflow

When a suspected unrelated flake appears during another task, delegate its investigation to a sub-agent immediately
if sub-agents are available and the investigation has a disjoint write scope. Continue the main task while it runs.

Give the sub-agent:

- The exact command and failing output
- The current change summary and why the failure may be unrelated
- Relevant paths, services, runtime version, and environment variables
- A read/reproduce-first mandate
- A request for reproduction rate, mechanism, evidence, and the smallest proposed fix

Do not duplicate the sub-agent's investigation in the main thread. Do not let it modify files also being changed by
the main task.

A separate branch, commit, or draft PR requires explicit user authorization. When authorized, isolate a genuine
unrelated flake fix from the feature change and base it on the appropriate clean branch, normally `master`.

## Fixing the Cause

- Stop stray requests, close leaked resources, restore hooks, and remove shared mutable state rather than filtering
  observed effects.
- Replace real-time waits with sinon fake timers in unit tests.
- Fix test-order dependencies by restoring state and ownership boundaries, not by forcing an order.
- Fix port races with proper resource allocation and lifecycle management, not arbitrary delays.
- Pin relevant error fields and retain assertions that protect behavior.
- Search for and fix sibling occurrences of deterministic defects sharing the corrected path.

A deterministic failure—such as an assertion mismatch, missing fixture or cassette, stale path, or version
incompatibility—is not flaky and should be fixed with the change that exposed it when related.

## Hung Jobs

Treat a hang as a potentially masked failure. Inspect the last meaningful error and leaked handles such as tracer or
remote-configuration timers, sockets, child processes, servers, and unfinished hooks before considering a timeout
increase.

## Report

Report:

1. Classification: caused by current change, deterministic pre-existing defect, genuine unrelated flake, or unknown
2. Reproduction command and observed frequency
3. Evidence and one-line mechanism
4. Root-cause fix or next investigation step
5. Whether a separate tracked change is required
