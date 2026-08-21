# Diagnosis Questions

When a flake doesn't match a known shape, work through these questions in order. The aim is to move from "it sometimes fails" to a single mechanistic sentence that names the race, the shared resource, or the unbounded assumption. Don't propose a fix until you can write that sentence.

## Phase A — what is the failure actually saying?

Before hypothesising, read the failure carefully.

- What is the exact assertion that failed? Quote the line.
- What is the actual value vs. the expected value? Was the gap small (a few ms / one off) or large (10x off)?
- Does the assertion message reveal the actual measured value, or just "evaluated to a falsy value"? If the latter, you may need to instrument before re-running.
- Is the stack trace inside the test, in instrumented production code, or in a Mocha hook?
- What test ran *immediately before* this one in the same job? Order-dependence flakes name the previous test, not the failing one.
- Is the same test stable on other platforms / Node versions / OSes, or flaking everywhere?

## Phase B — timing vs. structural

The most important distinction. A timing answer is rarely a complete answer.

- Why does it not always fail? What invariant holds in the passing cases that occasionally breaks?
- If a timeout is involved: would a longer timeout actually help, or is the work *not happening at all* in failure cases?
- Is there a sleep or fixed-retry-count anywhere on the path? Treat that as the prime suspect (pattern 4).
- Is there a `Date.now()` / `Date()` / `new Date()` comparison? Cross-check against any monotonic timing in production code (pattern 5).
- Is the test asserting on a statistical outcome of a random source? (pattern 10).

## Phase C — shared state and order-dependence

- What modules cache something across tests? `require.cache`, mongoose `models`, mocha lifecycle hooks, `process.listeners`, `dc.channel(...)`, plugin subscriber registries.
- Is there a global registry that survives between tests? Was registration designed to be idempotent? (pattern 7).
- Are there event listeners installed in one test that fire in a later test?
- Are there processes / sockets / servers that may outlive their test? Are cleanup hooks split, or combined where one failure skips the rest? (pattern 6).
- Hardcoded port? File path collision? Locked DB row? (pattern 2).
- Mocha's `--retries 1` is active on `master`. Could a transient first-run failure be exposing a state-leak bug that only manifests under retry?

## Phase D — async / concurrency

- Does the test fire an async operation and assert on its result *without* awaiting a deterministic signal that the result is ready? (`assertSomeTraces`, `agent.use`, etc. provide deterministic signals — use them.)
- Are there multiple async producers writing to the same buffer / collection? Is the assertion order-sensitive? (pattern 1).
- Is the instrumentation handler registered lazily on first use? Could the first test of the suite be racing the registration? (pattern 8).
- Is there a `Promise.race` / `Promise.all` that swallows a rejection from one branch?

## Phase E — environment and external dependencies

- Does the test depend on a daemon (Xvfb, Selenium, docker container) being ready? Is there a readiness check or a `sleep`? (pattern 9).
- Does the service readiness check probe the *exact* port / service the test uses, or a sibling? (pattern 11).
- Is there a peer dependency that the test installs in a way the user wouldn't? (pattern 12).
- Are there environment variables that differ between local and CI (e.g. the OTEL exporter trap)?
- Is the failure ARM64-specific? Some plugins (`aerospike`, `couchbase`, `grpc`, `oracledb`) are documented as ARM64-incompatible.

## Phase E2 — the failure is in a CI step before the test runs

Sometimes the failure isn't in a test at all — it's a `docker pull`, an OIDC token exchange, a yarn install hitting a registry, an action download. Investigate, don't dismiss:

- *What service was contacted, and what would the consequence of a transient failure look like?* `Get "https://registry-1.docker.io/v2/": context deadline exceeded` and `Failed to exchange OIDC token: Fetch failed after 4 attempts` are both legitimate fixable problems if the workflow's retry policy is too aggressive on backoff or too small on attempt count.
- *Does the step already have retries?* How many, with what backoff? Are all retries falling inside the same window (i.e. no backoff means they all hit the same network blip)?
- *Is the dependency necessary at all in this job?* A `docker pull` for a tool only one step uses may be hoistable to a separate job, or replaceable with a smaller image.
- *Is the dependency cached anywhere?* Layer cache, action cache, GHCR mirror, registry-cache proxy.
- *Is this an opaque runner-side failure* (kernel panic, disk full, network adapter reset)? If after a real investigation the cause is genuinely "the runner had a bad day", document it on the workflow file and stop — but don't reach that conclusion before investigating.

See [patterns.md §13](patterns.md) for fix shapes.

## Phase F — the "are you sure?" gut check

Before committing to a fix, answer:

- If a senior reviewer asked "why does this fix actually eliminate the race?", what is the one-sentence answer? If you can't answer mechanistically, the diagnosis isn't done.
- Could the same fix be expressed as "the test still passes with the bug present"? If yes, the test isn't a test (pattern 12).
- Would the fix survive a 50x local loop without any other change?
- Are there other tests in the same file that share the underlying assumption I just fixed? Do they need the same fix, or are they robust to it for a different reason?

If any answer is shaky, return to Phase A.
