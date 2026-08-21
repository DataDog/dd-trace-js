# Flake Pattern Catalog

Each pattern is keyed by the shape of the failure, with the canonical fix used in this repo and the PR that introduced it. When you recognise a shape, jump to the matching section, mirror the before/after, then verify per the SKILL.md workflow.

## 1. Mixed span order — `traces[0][0]` checks the wrong span

**Shape.** A test triggers spans across two layers (e.g. an http2 client *and* its server, or main + renderer Electron processes). Both spans can land in the same batch sent to the test agent, in either order. The test asserts `traces[0][0]`, which sometimes catches the wrong span; `assertSomeTraces` does not retry because the callback didn't throw.

**Symptom.**

```
AssertionError: 'http.request' !== 'web.request'
```

…with no further batches, so the suite hangs / times out.

**Fix.** Filter the batch by span name. If nothing matches, `throw` so `assertSomeTraces` retries on the next batch instead of asserting on a span that hasn't arrived yet.

```javascript
// Before — flaky
agent.assertSomeTraces(traces => {
  expect(traces[0][0]).to.have.property('name', 'web.request')
  expect(traces[0][0].error).to.equal(1)
})

// After — order-resilient
agent.assertSomeTraces(traces => {
  const span = traces[0].find(t => t.name === 'web.request')
  if (!span) throw new Error('web.request span not in this batch')
  expect(span).to.have.property('error', 1)
})
```

For tests that triggered both spans intentionally, prefer asserting on each by name in separate `find()` calls over relying on positional indexing.

**Reference PRs:** #8642 (http2 cancelled-request), #8546 (electron IPC tests, 4 sites).

## 2. Port reuse — `EADDRINUSE` and stuck listeners

**Shape.** A server test listens on a hardcoded port (e.g. `6015`). When the test re-runs (mocha retry, parallel CI, leaked process from a prior run), the second `listen` fails with `EADDRINUSE`, or — worse — silently connects to the previous process and asserts against stale state.

**Symptom.** `Error: listen EADDRINUSE: address already in use :::6015`, or assertions that pass once then fail on retry.

**Fix.** Always listen on `port: 0` (kernel-assigned) and read the actual port from the listener.

```javascript
// Before
const PORT = 6015
beforeEach(done => {
  server = http2.createServer().listen(PORT, done)
})
// client side hardcodes 6015 too

// After
let port
beforeEach(done => {
  server = http2.createServer().listen(0, () => {
    port = server.address().port
    done()
  })
})
// client uses `port`
```

Do **not** add manual port tracking ("avoid reusing this port"). The kernel guarantees uniqueness with `port: 0`; tracking is dead weight that itself becomes a flake source.

While you're at it: kill any `proc.kill(0)` you find — signal 0 is a liveness check, not a kill. Use `proc.kill('SIGTERM')` then `proc.kill('SIGKILL')` if cleanup needs to be forceful.

**Reference PRs:** #8641 (http2 server tests), #8367 (ws lifecycle hooks).

## 3. Arrow function in a Mocha hook — `this.timeout()` no-ops

**Shape.** A `describe` / `before` / `beforeEach` is written as an arrow function and calls `this.timeout(10_000)` or relies on the parent suite's timeout. Arrow functions don't bind `this`, so the call has no effect and the hook silently uses the 5000ms default. The first time a CI runner is slow, the hook times out.

**Symptom.** `Error: Timeout of 5000ms exceeded.` (always 5000, never the value you intended), often in a `before`/`beforeEach` that connects to a service.

**Fix.** Convert the arrow to a regular function. Apply at the hook level *and* at the `describe` level if either calls `this.timeout()`.

```javascript
// Before — silently 5000ms
describe('couchbase', () => {
  beforeEach(async () => {
    this.timeout(10_000) // no-op — `this` is the module
    cluster = await couchbase.connect(...)
  })
})

// After
describe('couchbase', function () {
  this.timeout(10_000)

  beforeEach(async function () {
    cluster = await couchbase.connect(...)
  })
})
```

Note: a `describe`-level `this.timeout(N)` applies to `it` blocks but **not** to nested hooks in older Mocha versions. If the hook itself needs a higher timeout, set it on the hook function too.

**Reference PR:** #8550 (aerospike, couchbase).

## 4. Fixed sleep / fixed retry count for an async condition

**Shape.** A test calls `gc()` three times with `setTimeout(200ms)` between, or polls for a condition N times, or sleeps "long enough". On a slow CI runner the condition isn't met yet; on a fast one the test wastes time.

**Symptom.** Test passes locally but fails on CI. Or test always takes the full sleep duration even when the condition is met immediately.

**Fix.** Bounded polling loop that exits as soon as the condition holds. Pick the cadence based on how quickly the event is expected, and the ceiling based on the worst-case slow runner.

```javascript
// Before — fixed retries with fixed sleep
for (let i = 0; i < 3; i++) {
  global.gc()
  await new Promise(r => setTimeout(r, 200))
}
expect(receiveSpans.has(req)).to.equal(false)

// After — adaptive polling, bounded
const deadline = Date.now() + 8000
while (receiveSpans.has(req) && Date.now() < deadline) {
  global.gc()
  await new Promise(r => setTimeout(r, 100))
}
expect(receiveSpans.has(req)).to.equal(false)
```

In the common case the loop exits within a couple of iterations. The 8s ceiling only applies on genuinely slow runners; it does *not* always wait the full window.

For external services, prefer a service-native readiness check (e.g. `couchbase` N1QL `system:keyspaces` query) over a generic TCP-connect or sibling-port check.

**Reference PRs:** #8553 (pubsub GC finalizer), #8550 (couchbase readiness).

## 5. Wall-clock vs monotonic-clock skew

**Shape.** A test asserts that two events are at least `N` ms apart (e.g. sampling rate test). The production code uses `process.hrtime.bigint()` (monotonic) for enforcement, but the timestamps the test diffs come from `Date.now()` (wall clock, intentionally — they ship to Datadog). NTP slewing on CI moves the wall clock relative to the monotonic clock; the assertion fails by a few ms.

**Symptom.** `AssertionError: The expression evaluated to a falsy value: assert.ok(duration >= 1000)` with a tiny margin (e.g. `duration = 998`).

**Fix.** Widen tolerance with a comment naming the clock-source mismatch, and include the actual measured value in the assertion message so the next failure is self-diagnosing.

```javascript
// Before
assert.ok(duration >= 1000)
assert.ok(duration < 1050)

// After
// Sampling enforcement uses process.hrtime.bigint() (monotonic), but
// the snapshot timestamp uses Date.now() (wall clock — that's what
// we ship to Datadog). NTP slewing on CI can skew the two by a few
// ms within the sampling window, so we allow ±75ms here.
assert.ok(duration >= 925, `duration was ${duration}, expected >= 925`)
assert.ok(duration < 1075, `duration was ${duration}, expected < 1075`)
```

Do **not** change the production code to use one clock for both purposes — the dual-clock design is correct (monotonic for enforcement, wall-clock for the timestamp we send).

**Reference PR:** #8534 (debugger sampling spec).

## 6. Combined `afterEach` callback — one failure skips remaining cleanup

**Shape.** An `afterEach` does multiple unrelated cleanups in one callback. If the first one throws, the rest never run, the next test inherits leaked state, and the failure manifests far from its cause.

**Symptom.** Cascading test failures after one initial failure. State that should be cleaned looks "still there".

**Fix.** Split into one `afterEach` per concern. Mocha runs them independently — a throw in one doesn't skip the rest.

```javascript
// Before — one cleanup throws, the others don't run
afterEach(() => {
  socket.destroy()
  server.close()
  proxy.close()  // never runs if socket.destroy() throws
})

// After — independent hooks
afterEach(() => socket.destroy())
afterEach(() => server.close())
afterEach(() => proxy.close())
```

The same principle applies to `beforeEach` / `before` / `after`.

**Reference PR:** #8367 (ws).

## 7. `OverwriteModelError` on Mocha auto-retry

**Shape.** `mongoose.model('X', schema)` is called in the test setup. The test fails for an unrelated reason, Mocha's `--retries 1` reruns it, and the second registration throws `OverwriteModelError: Cannot overwrite \`X\` model`. The visible failure is the registration error, but the *cause* is whatever made the first attempt fail.

**Symptom.** `OverwriteModelError: Cannot overwrite 'PeerCat' model once compiled.` only on `master` (where `--retries 1` is active), not on PR branches.

**Fix.** Idempotent registration. Look up an existing model and reuse it.

```javascript
// Before
const PeerCat = mongoose.model('PeerCat', schema)

// After
const PeerCat = mongoose.models.PeerCat ?? mongoose.model('PeerCat', schema)
```

Then investigate *what made the first attempt fail* — that's the real flake. Don't stop at "I made it survive the retry".

**Reference PR:** #8551 (mongoose).

## 8. Handler registration race — request fires before subscribe is live

**Shape.** A test for instrumentation (RASP, AppSec, etc.) expects a span to be reported when an outbound request is made. But the handler that produces the span isn't registered until the diagnostic channel subscription completes on first use; the first test in the suite fires its request before that subscription is live, so the span is missing.

**Symptom.** "First test of suite" fails; subsequent identical tests pass. Or the suite passes locally (warmed module cache) and fails on a fresh CI worker.

**Fix.** Add a `before` hook that issues a warmup request and awaits the resulting span being drained to the test agent, so subscriptions are guaranteed live when real assertions run.

```javascript
// Before — first test races against subscription
beforeEach(() => {
  // assertions...
})

// After
before(async () => {
  // Trigger handler registration on a throwaway request and wait
  // until the resulting span lands in the test agent. This ensures
  // every subsequent test has the instrumentation primed.
  await axios.get(`http://localhost:${port}/__preload__`)
  await agent.assertSomeTraces(() => {})  // any batch will do
})
```

Do **not** "fix" this by shortening the request timeout on the actual test — that's narrowing the symptom, not removing the race.

**Reference PR:** #8547 (rasp-metrics integration test).

## 9. External daemon startup race (Xvfb, browser driver, etc.)

**Shape.** A CI step launches a daemon in the background and immediately runs tests. The daemon isn't ready; the first test's connection fails or times out.

**Symptom.** First test of an Electron / Selenium / Playwright job fails to connect to display, then subsequent tests pass.

**Fix.** Wait for a daemon-specific readiness signal before launching tests.

```yaml
# Before
- run: Xvfb :99 &
- run: npm test

# After
- run: |
    Xvfb :99 &
    until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done
- run: npm test
```

Install whatever tool provides the readiness check (e.g. `x11-utils` for `xdpyinfo`). Don't rely on `sleep 5` — that's a fixed-sleep flake (pattern 4) in a different shell.

**Reference PR:** #8546 (Xvfb readiness).

## 10. Non-deterministic source driving an assertion

**Shape.** A test relies on `Math.random()` or some other non-deterministic source and asserts on the *statistical* outcome (e.g. "we sampled at roughly N events per second"). When the random sequence runs hot or cold, the assertion fails. The test has been patched repeatedly by relaxing thresholds.

**Symptom.** Multi-year history of the same test getting "fixed" by widening tolerance, only to flake again.

**Fix.** Inject the source so the test can pin it. Remove the non-determinism, then assert on the deterministic outcome.

```javascript
// Production code — before
function poissonInterval (rate) {
  return -Math.log(1 - Math.random()) / rate
}

// Production code — after
function poissonInterval (rate, random = Math.random) {
  return -Math.log(1 - random()) / rate
}

// Test
const fixedRandom = sinon.stub().returns(0.5)
const interval = poissonInterval(rate, fixedRandom)
expect(interval).to.equal(Math.log(2) / rate)
```

If injecting into production code is a layering violation, expose the randomness through a constructor option or a module-scoped setter used only in tests, documented as such.

**Reference:** #8550-adjacent poisson fix.

## 11. Service readiness checked against the wrong service

**Shape.** A docker-compose `wait_for_X` script polls one port (e.g. Couchbase Analytics on 8095) but the test uses a different service on the same container (N1QL on 8093). The probe passes when the wrong service is ready, the test fires queries against the unready service and times out.

**Symptom.** `ambiguous_timeout (13)` or service-specific timeout errors only on first runs of the day; later runs (cached image, warm container) pass.

**Fix.** Probe the *exact* service the tests will use, with a service-native query that confirms the keyspace / topic / collection / index is actually accessible.

```bash
# Before
until nc -z couchbase 8095; do sleep 1; done

# After — wait until the N1QL service can list the test bucket
until curl -sf -u Administrator:password \
      http://couchbase:8093/query/service \
      -d 'statement=SELECT * FROM system:keyspaces WHERE name="datadog-test"' \
    | grep -q '"name":"datadog-test"'; do
  sleep 1
done
```

**Reference PR:** #8550 (couchbase service readiness).

## 12. Mocked dependency hides the real failure mode

**Shape.** A test for a bundler / runtime / peer-dependency integration mocks out the dependency being integrated. The mock is too permissive; the real failure (e.g. a peer dep not being optional under webpack) never surfaces.

**Symptom.** Regression test in PR description "passes both with and without the bug" — the mock papers over the bug. Or: a real-world bug report describes a failure that no test in the repo would catch.

**Fix.** Add real-integration tests that exercise the actual failure mode. For peer-dep cases, install the suite with `--omit=peer` (or whichever flag matches the failure). For bundler regressions, run the actual bundler.

```javascript
// Before — esbuild stub
const plugin = { setup (build) { /* fake */ } }
const result = await esbuild.build({ plugins: [plugin] })

// After — drive the real bundler against the real fixture
const result = await esbuild.build({
  entryPoints: [path.join(fixtureDir, 'app.js')],
  bundle: true,
  platform: 'node',
  external: knownExternals
})
```

A regression test must fail when the regression is present. Verify by reverting the production fix and rerunning — the test should fail. If it passes either way, it's not a test, it's documentation.

**Reference PR:** #8559 (electron flagging provider integration tests).

## 13. External-service step failure in CI (Docker Hub, OIDC, package registry)

**Shape.** A CI step depends on an external service that occasionally fails or times out — `docker pull` from Docker Hub, OIDC token exchange with an STS endpoint, fetching a release tarball from `nodejs.org`, an npm/yarn install hitting a registry. The job fails before any test runs.

**Symptom.** Single-occurrence failures sprinkled across unrelated jobs. Examples:

```
Error response from daemon: Get "https://registry-1.docker.io/v2/":
  net/http: request canceled while waiting for connection
  (Client.Timeout exceeded while awaiting headers)
##[error]Docker pull failed with exit code 1
```

```
Attempt 1 for https://webhooks.build.datadoghq.com/sts/datadog/exchange...
  failed. Error: fetch failed
Attempt 2 ... failed
Attempt 3 ... failed
##[error]Failed to exchange OIDC token for Datadog credentials:
  Fetch failed after 4 attempts.
```

**These are still in scope for this skill.** The fix doesn't live in test code, but in the CI plumbing the test runs through — and that plumbing is in the repo.

**Fix options, in order of preference.**

1. **Make the dependency unnecessary.** If the workflow downloads an image just to run one step, can it use a smaller base image already cached on the runner? Can the step be hoisted into a job that's allowed to fail without blocking?

2. **Add adaptive retry to the step.** Most "transient external service" failures resolve on a second attempt. Wrap the failing step with a small retry loop and exponential backoff:

   ```yaml
   - name: Pull image with retry
     run: |
       for i in 1 2 3 4 5; do
         docker pull "$IMAGE" && break
         echo "Pull attempt $i failed, sleeping $((i * i * 5))s"
         sleep $((i * i * 5))
       done
   ```

   Or use a third-party action that wraps retries:

   ```yaml
   - uses: nick-fields/retry@v3
     with:
       timeout_seconds: 120
       max_attempts: 5
       retry_wait_seconds: 15
       command: docker pull "$IMAGE"
   ```

3. **Pin to a digest and cache the artifact.** If Docker Hub keeps timing out on the same image, pin to a SHA digest and cache the layer in GHCR so subsequent runs don't re-pull from the upstream registry:

   ```yaml
   - uses: actions/cache@v4
     with:
       path: /tmp/.buildx-cache
       key: image-${{ env.IMAGE_DIGEST }}
   ```

4. **Increase the existing retry policy.** Many failing steps already retry — the OIDC step in the example above retries 3 times, but all three attempts fell inside the same network blip. Bumping to 5 attempts with longer backoff converts a 1-in-100 failure into a 1-in-many-thousands failure for the same wall-time cost.

5. **Mirror or proxy the dependency.** For dependencies that fail repeatedly under load (Docker Hub rate-limits anonymous pulls; npm registry has regional outages), proxy through a registry your org controls or use a regional mirror endpoint.

**Decision rule.** A 1-in-1000 external failure rate compounded across N jobs per PR produces a real success-rate hit. The math is simple: with 30 jobs each at 99.9%, the workflow-level success rate is `0.999^30 ≈ 97%` — a 3% red rate from causes the team has no control over the *root* of but does have control over the *exposure* to. Don't accept that as background noise; the retry/cache/mirror lever is the right tool here.

**Anti-patterns specific to infra flakes.**

- Adding a retry to the *test* to compensate for an *infrastructure* failure. The test isn't flaky; the infrastructure step before it is. Fix the infra step.
- "Just rerun the failed job manually." A team-wide habit; turns into a tax on every contributor and never gets fixed.
- Removing the dependency without understanding what it provides. The OIDC step exists for a reason; replacing it with a static secret is a security regression.

**When it really is out of scope.** Some failures are genuinely opaque from inside the repo — a runner restart mid-job, a GitHub Actions outage, a corrupted runner image. If five attempts at retry / mirroring / pinning don't land it, document the symptom in a comment on the workflow file and move on. The skill's job is to investigate, not to fix the unfixable.

**Reference PRs:** the `ci-retry` pattern shows up in several merged PRs — `ci(actions/cache): work around windows flakiness` (#8584), `ci: retry yarn install on failure in datadog-ci action` (#8459).
