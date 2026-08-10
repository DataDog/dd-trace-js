# Implementation plan — PII hashing in dd-trace-js flagevaluations

- Spec: `docs/superpowers/specs/2026-08-06-pii-flagevaluations-js-design.md`
- Jira: FFL-2965
- Branch: `vickie/ffl-2965-protecting-pii-in-js-flagevaluations-track` (stacked on
  `leo.romanovsky/ffl-2446-evp-flagevaluation-nodejs`)

## Verification loop between steps

After each step: (1) `npm run lint` on changed files, (2) run the affected
`*.spec.js` files directly with `./node_modules/.bin/mocha`, (3) confirm no
untouched suites regressed. Never claim a step complete without running its
tests.

## Step 1 — UFC parse: accept `observeFullEvaluationData` at the root

**Goal:** parse the new UFC field from both agentless and Remote Config
delivery paths, fail closed on absence, wrong type, and nested placement.

**Files:**

- `packages/dd-trace/src/openfeature/agentless_configuration_source.js`
  - In `parseConfiguration`, after the existing `attributes.format` /
    `attributes.environment.name` / `attributes.flags` validation, coerce
    `attributes.observeFullEvaluationData` with `=== true`. Any other value —
    including `undefined`, `null`, `"true"`, `1`, `[]`, `{}` — becomes `false`.
    Assign the coerced boolean back onto `attributes` so downstream consumers
    see a strict boolean, never `undefined`.
- `packages/dd-trace/src/openfeature/remote_config.js`
  - Apply the same coercion where the RC-delivered configuration is handed to
    `setConfiguration`. If both paths already funnel through one point, add the
    coercion there; otherwise add a small shared helper in a new file
    `packages/dd-trace/src/openfeature/ufc_consent.js` exporting
    `coerceObserveFullEvaluationData(attributes)`.

**Tests:**

- `packages/dd-trace/test/openfeature/agentless_configuration_source.spec.js`
  - `it('parses observeFullEvaluationData=true at the UFC root')`
  - `it('defaults observeFullEvaluationData to false when absent')`
  - `it('treats explicit null as false')`
  - Parametric `it(\`treats \${value} as false\`)` over
    `[1, 0, 'true', 'false', [], {}]`.
  - `it('ignores observeFullEvaluationData nested inside environment')` — the
    FFL-2784 placement-drift guard. Construct a UFC with
    `attributes.environment.observeFullEvaluationData = true` and the root
    field absent; assert the resulting object's root
    `observeFullEvaluationData` is `false`.
- `packages/dd-trace/test/openfeature/remote_config.spec.js`
  - Mirror the root-parse and placement-drift tests for the RC path.

**Verification:**

```bash
./node_modules/.bin/mocha \
  packages/dd-trace/test/openfeature/agentless_configuration_source.spec.js \
  packages/dd-trace/test/openfeature/remote_config.spec.js
```

## Step 2 — Static `hashTargetingKey` on FlagEvaluationsWriter

**Goal:** ship the cross-SDK hash contract as a static method next to its only
consumer, pinned by the canonical vector and the non-normalization tests.

**Files:**

- `packages/dd-trace/src/openfeature/writers/flag_evaluations.js`
  - Add `const { createHash } = require('node:crypto')` at the top of the
    file, in the third import group (per AGENTS.md import ordering).
  - Add a static method on `FlagEvaluationsWriter`:
    ```js
    static hashTargetingKey (value) {
      return 'sha256_' + createHash('sha256').update(value, 'utf8').digest('hex')
    }
    ```
    JSDoc: `@param {string} value @returns {string}`. Note the hash contract:
    unsalted, no normalization, lowercase hex, `sha256_` prefix, 71 chars.

**Tests:**

- New file
  `packages/dd-trace/test/openfeature/writers/hash_targeting_key.spec.js`:
  - `it('matches the cross-SDK canonical vector')` —
    `hashTargetingKey('jane.doe@datadoghq.com')` must equal
    `'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b'`.
  - `it('produces a 71-char output')`.
  - `it('does not trim whitespace')` — `' jane '` and `'jane'` yield distinct
    digests.
  - `it('does not case-fold')` — `'Jane'` and `'jane'` yield distinct digests.
  - `it('does not Unicode-normalize')` — NFC-composed and NFD-decomposed
    variants of the same visible string yield distinct digests. Write both
    variants with explicit `\u` escapes so editor auto-normalization cannot
    collapse them.
  - `it('hashes empty string to the SHA-256 empty digest')` —
    `hashTargetingKey('')` equals
    `'sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'`.

**Verification:**

```bash
./node_modules/.bin/mocha packages/dd-trace/test/openfeature/writers/hash_targeting_key.spec.js
```

## Step 3 — Atomic snapshot on FlaggingProvider

**Goal:** expose `{ configuration, observeFullEvaluationData }` as one
immutable reference the hook can read atomically.

**Files:**

- `packages/dd-trace/src/openfeature/flagging_provider.js`
  - Add a `#snapshot` private field, initialised to
    `Object.freeze({ configuration: undefined, observeFullEvaluationData: false })`.
  - Override `setConfiguration(configuration)`:
    ```js
    setConfiguration (configuration) {
      super.setConfiguration(configuration)
      this.#snapshot = Object.freeze({
        configuration,
        observeFullEvaluationData: configuration?.observeFullEvaluationData === true,
      })
    }
    ```
  - Add a private `#getConsent = () => this.#snapshot.observeFullEvaluationData`
    binding. **Do not expose a public getter** — the arrow function is passed
    to the EVP hook constructor and nowhere else. This is the "delete the
    accessor" defense from the Java pilot: no external reader can bypass the
    intended path.
  - Update the `FlagEvalEVPHook` construction line to pass `this.#getConsent`:
    ```js
    this.hooks.push(new FlagEvalEVPHook(this.#flagEvalEVPWriter, this.#getConsent))
    ```

**Tests:**

- `packages/dd-trace/test/openfeature/flagging_provider.spec.js`
  - `it('starts with observeFullEvaluationData=false before any configuration')` —
    construct provider, no `setConfiguration` call, evaluate through the mocked
    upstream base, assert the writer received `observeFullEvaluationData: false`.
  - `it('reflects setConfiguration atomically in subsequent evaluations')` —
    call `setConfiguration({ ..., observeFullEvaluationData: true })`, evaluate,
    assert writer sees `true`. Then call `setConfiguration` again with `false`,
    evaluate again, assert writer sees `false`.
  - `it('freezes the snapshot so external code cannot mutate consent')` — grab
    a reference to the snapshot (via a test-only escape hatch or by evaluating
    once and reading what the writer received) and assert
    `Object.isFrozen(snapshot)` where applicable.

**Verification:**

```bash
./node_modules/.bin/mocha packages/dd-trace/test/openfeature/flagging_provider.spec.js
```

## Step 4 — FlagEvalEVPHook: consent read, context-capture skip, event field

**Goal:** the hook takes consent once at `finally` entry, drops context capture
entirely when consent is off, and passes the strict boolean to the writer.

**Files:**

- `packages/dd-trace/src/openfeature/writers/flag_eval_evp_hook.js`
  - Constructor takes a second argument, `getConsent: () => boolean`. Store on
    `this._getConsent`. Default to `() => false` when absent (fail-closed on
    tests that construct the hook directly).
  - In `finally`:
    - `const consent = this._getConsent()`.
    - `const attrs = consent ? (hookContext.context ?? {}) : {}` — this is the
      "consent-off skip context capture on the hot path" optimization from the
      Java pilot's `concern:consent-off-bucket-keying` lesson.
    - Pass `observeFullEvaluationData: consent` in the `enqueue` payload.

**Tests:**

- `packages/dd-trace/test/openfeature/writers/flag_eval_evp_hook.spec.js`
  - `it('reads consent from getConsent at hook entry')` — spy on `getConsent`,
    assert called once per `finally`.
  - `it('passes observeFullEvaluationData=false to the writer when consent is off')`.
  - `it('passes observeFullEvaluationData=true to the writer when consent is on')`.
  - `it('skips context capture when consent is off')` — construct a
    `hookContext.context` with populated attributes; assert the writer
    received `attrs === {}`, and specifically that the writer did not see any
    of those attribute values.
  - `it('captures context normally when consent is on')`.
  - `it('fails closed when getConsent is not provided')` — construct the hook
    with only the writer argument; assert the writer receives
    `observeFullEvaluationData: false`.

**Verification:**

```bash
./node_modules/.bin/mocha packages/dd-trace/test/openfeature/writers/flag_eval_evp_hook.spec.js
```

## Step 5 — FlagEvaluationsWriter: consent in bucket key, hash at flush

**Goal:** wire consent through aggregation and serialization. Raw targeting key
stays on the in-memory entry through aggregation; the hash is applied only in
`_drainFlagEvaluations` when consent is off, once per unique bucket.

**Files:**

- `packages/dd-trace/src/openfeature/writers/flag_evaluations.js`
  - Extend `FlagEvalRawEvent` typedef with
    `observeFullEvaluationData: boolean`.
  - Extend `FullEntry` and `DegradedEntry` typedefs with
    `observeFullEvaluationData: boolean`.
  - Update `makeFullKey` and `makeDegradedKey` to take `consent` as the first
    argument. Consent leads the NUL-delimited string as `'1'` or `'0'`.
  - In `enqueue`:
    - Push `observeFullEvaluationData: event.observeFullEvaluationData === true`
      onto the raw queue (strict coercion for defense in depth).
    - When consent is `false`, skip `pruneContext(event.attrs || {})` entirely
      and store `attrs: {}` on the raw event. `contextFitsWithoutFlattening`
      already handles the empty case cheaply, but this saves the call itself.
  - In `_aggregate`:
    - Read `consent = event.observeFullEvaluationData`.
    - Pass `consent` to `makeFullKey` / `makeDegradedKey`.
    - When updating an existing entry, AND-fold consent:
      `existing.observeFullEvaluationData = existing.observeFullEvaluationData && consent`.
      (In practice a no-op because the key partitions by consent; a defense in
      depth against a future key drift.)
    - On new-entry creation, store `observeFullEvaluationData: consent`.
  - In `_drainFlagEvaluations`:
    - When writing the full-tier `ev.targeting_key`:
      ```js
      if (entry.targetingKey) {
        ev.targeting_key = entry.observeFullEvaluationData
          ? entry.targetingKey
          : FlagEvaluationsWriter.hashTargetingKey(entry.targetingKey)
      }
      ```
    - Leave the `entry.contextAttrs !== null` branch as-is; when consent is off,
      `contextAttrs` is null by construction (the hook passed empty attrs, so
      `hasOwnKey(attrs)` was false in `_aggregate`).
    - Degraded tier already emits no targeting_key or context — no change.

**Tests:**

- `packages/dd-trace/test/openfeature/writers/flag_evaluations.spec.js`
  Add a new `describe('observeFullEvaluationData', ...)` block:
  - `it('hashes targeting_key when observeFullEvaluationData is false')` —
    enqueue one event with consent off and a known targeting key; flush; assert
    the payload's event has `targeting_key` equal to the canonical hash.
  - `it('preserves raw targeting_key when observeFullEvaluationData is true')`.
  - `it('omits context when observeFullEvaluationData is false')` — enqueue
    with populated attrs and consent off; assert flushed event has no
    `context` property.
  - `it('includes pruned context when observeFullEvaluationData is true')`.
  - `it('separates buckets by consent value')` — two enqueues with same subject
    but different consent; flush; assert two events with distinct
    `targeting_key` values (one hashed, one raw).
  - `it('merges consent-off events across distinct contexts into one bucket')` —
    regression guard for `concern:consent-off-bucket-keying`. Two enqueues with
    consent off, same subject, different attrs; assert one flushed event with
    `evaluation_count: 2`.
  - `it('keeps consent-on events with distinct contexts distinct')`.
  - `it('AND-folds consent as defense in depth')` — construct an event stream
    that would produce a key collision without consent in the key (needs a
    test-only override to `makeFullKey`), assert the resulting entry has
    `observeFullEvaluationData === false` even if one of the inputs was `true`.
  - `it('hashes at flush cadence, not per evaluation')` — spy on
    `createHash` (via a `sinon.stub` on the crypto module through
    proxyquire, or via `sinon.spy(FlagEvaluationsWriter, 'hashTargetingKey')`).
    Enqueue N events sharing one bucket; flush; assert exactly 1 hash call.
  - `it('does not leak the raw targeting key in the payload bytes when consent is off')` —
    the raw-wire negative control. Enqueue with consent off; capture the
    serialized payload string (intercept `_sendPayload`); assert
    `!payload.includes(rawTargetingKey)` and
    `!payload.includes(anyPiiAttributeValue)`.
  - `it('emits nothing raw in the degraded tier under either consent')`.

**Verification:**

```bash
./node_modules/.bin/mocha packages/dd-trace/test/openfeature/writers/flag_evaluations.spec.js
```

## Step 6 — End-to-end and lifecycle guards

**Goal:** prove that `setConfiguration` flows through to the writer, and that a
consent swap between evaluate and flush cannot retroactively change the emitted
data.

**Files:**

- `packages/dd-trace/test/openfeature/flagging_provider.spec.js`
  - `it('flows setConfiguration observeFullEvaluationData=false through to hashed targeting_key on the wire')` —
    full stack, mocked upstream base and mocked EVP transport. Assert the sent
    payload has a `sha256_`-prefixed `targeting_key` and no `context`.
  - `it('flows setConfiguration observeFullEvaluationData=true through to raw targeting_key on the wire')`.
  - **Consent-lifecycle guard, off→on.** Set consent off → evaluate a flag →
    swap to consent on via a second `setConfiguration` → flush → assert the
    flushed event still shows the hashed targeting key (the evaluation-time
    consent), not the post-swap raw value. This is the single most important
    regression test in this PR.
  - **Consent-lifecycle guard, on→off.** Symmetric. Evaluate under consent on,
    swap to off, flush; assert the flushed event carries the raw targeting key
    (and included context), not a hashed one.
  - `it('is unaffected by DoLog for each consent value')` — for each of
    `{consent: true, doLog: true}`, `{consent: true, doLog: false}`,
    `{consent: false, doLog: true}`, `{consent: false, doLog: false}`, assert
    the flushed-event JSON is stable across the `doLog` values within each
    consent value.
  - `it('does not construct the writer or EVP hook when DD_FLAGGING_EVALUATION_COUNTS_ENABLED is false')` —
    kill-switch precedence. Assert `provider.hooks` has no `FlagEvalEVPHook`
    even when `observeFullEvaluationData: true`.

**Verification:**

```bash
./node_modules/.bin/mocha packages/dd-trace/test/openfeature/flagging_provider.spec.js
```

Then run the entire OpenFeature test surface to catch regressions in adjacent
suites:

```bash
./node_modules/.bin/mocha 'packages/dd-trace/test/openfeature/**/*.spec.js'
```

## Step 7 — Lint, coverage, and final validation

- `npm run lint` on all changed files.
- Scoped coverage on the touched paths:
  ```bash
  ./node_modules/.bin/nyc \
    --include "packages/dd-trace/src/openfeature/writers/flag_evaluations.js" \
    --include "packages/dd-trace/src/openfeature/writers/flag_eval_evp_hook.js" \
    --include "packages/dd-trace/src/openfeature/flagging_provider.js" \
    --include "packages/dd-trace/src/openfeature/agentless_configuration_source.js" \
    --include "packages/dd-trace/src/openfeature/remote_config.js" \
    ./node_modules/.bin/mocha 'packages/dd-trace/test/openfeature/**/*.spec.js'
  ```
  Confirm the new consent branches (bucket-key consent split, hash-at-flush,
  context-capture skip, snapshot atomicity, UFC placement guard) are covered.
- **Type check.** JSDoc changes must pass whatever TypeScript pass the repo
  runs on JSDoc. If the repo has an `npm run type-check` or equivalent, run it.
- **Do NOT** run `npm test` at the repo root — it's intentionally disabled per
  AGENTS.md.

## PR body checklist

The PR description should mirror Python #19554's structure and cite:

- RFC (`rfc:gdoc:19VIf4B9p-zsAL2uWSvdzil59DZlGjQm4yudAMwJBqLs`).
- Java pilot #12042, Go peer #5151, Python peer #19554.
- Jira FFL-2965 under FFL-2784.
- Explicit note that the base branch is
  `leo.romanovsky/ffl-2446-evp-flagevaluation-nodejs`, not `master`, and why.
- Explicit note that this must merge into the base track before the base track
  merges to master so no JS release ships raw `targeting_key` by default.
- The wire-shape truth table (from the spec).
- Cross-SDK canonical vector.
- Test summary: counts, and specifically call out the consent-lifecycle guard
  and the raw-wire negative control.
- Explicit "system-tests L3 is out of scope" note, with the tracked follow-up.
- Label: `semver-minor` (this is a new feature: the `observeFullEvaluationData`
  UFC read plus the hash-by-default wire shape).

## Commit strategy

One commit per step, `feat(openfeature):` for new-behavior commits and
`test(openfeature):` for pure-test additions. Java-pilot conventional-commit
style. Every commit ends with the required Claude attribution.
