# Protecting PII in flagevaluations EVP track — dd-trace-js

- Status: draft
- Owner: Vickie Boettcher (FFE)
- Jira: FFL-2965 (fan-out under FFL-2784, umbrella FFL-2780)
- Contract: `rfc:gdoc:19VIf4B9p-zsAL2uWSvdzil59DZlGjQm4yudAMwJBqLs`
  (`references/sources/rfcs/ffe/2026-07-15-protecting-pii-flagevaluations-evp.md`)
- Reference implementations:
  - Java pilot: [dd-trace-java#12042](https://github.com/DataDog/dd-trace-java/pull/12042)
  - Go: [dd-trace-go#5151](https://github.com/DataDog/dd-trace-go/pull/5151)
  - Python: [dd-trace-py#19554](https://github.com/DataDog/dd-trace-py/pull/19554)
- Branch: `vickie/ffl-2965-protecting-pii-in-js-flagevaluations-track`
- Base branch: `leo.romanovsky/ffl-2446-evp-flagevaluation-nodejs` (stacked, not `master`)

## Problem

Server SDKs upgrading to the EVP `flagevaluation` track today would ship raw
subject identifiers (targeting keys — often user emails, org IDs, or service
names) and full evaluation context to Datadog by default. This contradicts
Datadog's marketing that server-side flag evaluations happen locally and
introduces a silent-PII regression on upgrade.

The RFC changes the wire contract so that, by default, `targeting_key` is a
one-way SHA-256 fingerprint (`sha256_`-prefixed, 71 chars total) and
`context.evaluation` is omitted entirely. A single environment-scoped UFC
boolean `observeFullEvaluationData` selects the wire shape. Every SDK must
produce byte-identical digests for the same subject so per-(flag, allocation)
unique-subject counts still resolve across languages.

`dd-trace-js` has not yet shipped the base EVP `flagevaluation` track (FFL-2446).
The cluster README calls out that JS should fold the PII contract into the base
track or ship it stacked directly ahead of the base merge — never after — so
customers never receive a raw-PII default.

## Contract

| Server says `observeFullEvaluationData` | `targeting_key` on the wire | `context.evaluation` on the wire |
| --- | --- | --- |
| `true` | raw, verbatim | present, pruned |
| `false`, absent, or any non-`true` value (the default) | `sha256_` + 64-char lowercase hex (71 chars) | absent |

- **Hash spec:** unsalted SHA-256 over the raw UTF-8 bytes of the targeting key
  as received. No trim, no case fold, no Unicode normalization. Lowercase hex.
  Literal `sha256_` prefix. 71 chars total.
- **Canonical vector (must match across every SDK):**
  `"jane.doe@datadoghq.com"` →
  `sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b`.
- **Empty targeting key:** the field is already omitted when empty; hashing
  applies only to non-empty values. No `sha256_` emitted for absent subjects.
- **UFC placement:** `observeFullEvaluationData` is at the **root** of the UFC,
  a sibling of `environment`, not nested inside it. A value nested inside
  `environment` is ignored (fail-closed).
- **Fail-closed:** absent, explicit JSON `null`, and any non-boolean value all
  resolve to `false`. Only strict `=== true` grants opt-in.
- **Kill switch:** `DD_FLAGGING_EVALUATION_COUNTS_ENABLED=false` continues to
  disable the entire EVP `flagevaluation` track (writer and hook are not
  constructed). Kill switch always wins over UFC.
- **`DoLog` does not gate PII behavior.** The RFC explicitly forbids it; a
  regression test asserts the flushed-event bytes are identical across
  `doLog ∈ {true, false}` for each consent value.
- **Cross-SDK evaluation-metadata key:** `observe_full_evaluation_data`
  (unprefixed, snake_case) — the pilot-settled contract. Only used internally
  in JS (not surfaced through OpenFeature `flagMetadata` yet, see "Design
  Decisions" below).

## Where consent lives (the portable design)

The Java pilot established the contract every SDK must follow:

> Consent must travel with the evaluation, not be looked up later.

Any read of mutable global config after evaluation is a PII bug in both
directions — consent-off traffic can be emitted raw if consent flipped on
between evaluation and flush, and consent-on traffic can be needlessly hashed if
it flipped off. Both directions must have regression tests.

In JS, the evaluator lives upstream in `@datadog/openfeature-node-server`
(v2.0.2 today). It does not yet stamp `observe_full_evaluation_data` into
`ProviderEvaluation.flagMetadata`. The design must therefore snapshot consent at
a boundary this repo controls.

**The chosen boundary is `FlagEvalEVPHook.finally`.** OpenFeature `finally`
hooks run synchronously on the same call stack as the evaluation, before the
next await point returns to the caller. Reading consent once at hook entry —
from an atomic snapshot the provider maintains — gives the same lifecycle
guarantee as stamping metadata in the evaluator would: no Remote Config update
can interleave between the evaluation and the consent read.

A future refactor can move the consent stamp into the upstream evaluator (so
the hook reads `evaluationDetails.flagMetadata.observe_full_evaluation_data`
directly). The hook is the compatibility shim for today; when the evaluator
starts stamping, the hook flips to reading metadata and the provider's
`getConsent` accessor is deleted.

## Atomic snapshot

The provider stores UFC and consent as a single immutable object reference:

```js
this._snapshot = Object.freeze({
  configuration,
  observeFullEvaluationData: configuration?.observeFullEvaluationData === true,
})
```

`setConfiguration` on the FlaggingProvider does two things atomically from the
outside: (1) forwards the configuration to the upstream base, (2) replaces the
snapshot reference. A single field read (`this._snapshot`) returns a paired
`{ configuration, observeFullEvaluationData }` — no torn read is possible.

This mirrors Python's `_FfeSnapshot: NamedTuple` and Go's atomic pointer swap
of a struct value.

## Components

### `hashTargetingKey` — static method on `FlagEvaluationsWriter`

```js
static hashTargetingKey (value) {
  return 'sha256_' + createHash('sha256').update(value, 'utf8').digest('hex')
}
```

- Uses `node:crypto` (`createHash` cached at module load).
- Called at **flush cadence**, once per unique full-tier bucket where
  `observeFullEvaluationData === false`. Never per evaluation. This is a
  meaningful perf choice: N evaluations sharing one targeting key collapse
  into 1 bucket and 1 hash call, not N.
- Canonical vector pinned in a unit test named
  `it('matches the cross-SDK canonical vector')`.
- Non-normalization guarded by parametric tests (whitespace, case, NFC vs NFD).

### UFC parse — `parseConfiguration` in `agentless_configuration_source.js`

`parseConfiguration` and its RC counterpart share one helper:

```js
function readObserveFullEvaluationData (attributes) {
  return attributes?.observeFullEvaluationData === true
}
```

Applied at the top level only. A nested `environment.observeFullEvaluationData`
is silently ignored (a unit test guards this — this is the FFL-2784 placement
drift point).

### FlaggingProvider — atomic snapshot

- Adds `_snapshot` field, initialised to
  `{ configuration: undefined, observeFullEvaluationData: false }`.
- Wraps `setConfiguration(conf)`:
  1. `super.setConfiguration(conf)`
  2. `this._snapshot = Object.freeze({ configuration: conf, observeFullEvaluationData: conf?.observeFullEvaluationData === true })`
- Passes a `getSnapshot()` binding to `FlagEvalEVPHook` at construction, not a
  public accessor on the provider. This keeps the consent read a
  constructor-scoped dependency injection — external code cannot reach in.

### FlagEvalEVPHook — reads consent, conditionally captures context

```js
finally (hookContext, evaluationDetails) {
  const consent = this._getConsent()  // strict boolean
  const flagKey = hookContext.flagKey
  const variant = evaluationDetails.variant ?? ''
  const flagMetadata = evaluationDetails.flagMetadata
  const allocationKey = flagMetadata?.allocationKey ?? ''
  const targetingKey = hookContext.context?.targetingKey ?? ''
  const evalTimeMs = flagMetadata?.['dd.eval.timestamp_ms'] ?? Date.now()
  const errorMessage = evaluationDetails.errorMessage ?? evaluationDetails.errorCode ?? ''

  // Consent-off: skip capturing context entirely. The writer must not receive
  // attrs it will later discard — that would silently push privacy-protected
  // traffic through pruneContext for no downstream use.
  const attrs = consent ? (hookContext.context ?? {}) : {}

  this._writer.enqueue({
    flagKey, variant, allocationKey, targetingKey,
    errorMessage, evalTimeMs, attrs,
    observeFullEvaluationData: consent,
  })
}
```

Fail-closed everywhere: `_getConsent` returns strict boolean; `attrs = {}` when
consent is off; the writer defaults `observeFullEvaluationData` to `false` on
absence too.

### FlagEvaluationsWriter — consent in bucket key, hash at flush

**Raw event shape (extended):**

```js
{
  flagKey, variant, allocationKey, targetingKey, errorMessage,
  evalTimeMs, attrs,
  observeFullEvaluationData: boolean
}
```

**Bucket keys (extended):**

```js
function makeFullKey (consent, flagKey, variant, allocationKey, errorMessage, targetingKey, ctxKey) {
  return `${consent ? '1' : '0'}\0${flagKey}\0${variant}\0${allocationKey}\0${errorMessage}\0${targetingKey}\0${ctxKey}`
}

function makeDegradedKey (consent, flagKey, variant, allocationKey, errorMessage) {
  return `${consent ? '1' : '0'}\0${flagKey}\0${variant}\0${allocationKey}\0${errorMessage}`
}
```

Consent leads the key because it's the coarsest partition. Mixed-consent events
land in different buckets by construction. AND-fold on merge is defense in
depth (`existing.observeFullEvaluationData &&= event.observeFullEvaluationData`)
— a no-op when the key holds, a safety net when a future refactor breaks the
invariant.

**Aggregation, when consent is `false`:**

- `attrs` is already empty (the hook did not capture it).
- `ctxKey` is empty by construction.
- `entry.contextAttrs = null`; `_drainFlagEvaluations` emits no `context` field.
- `entry.targetingKey` holds the **raw** value on the entry. This is the design
  seam: raw stays on the entry through aggregation so N evaluations with the
  same subject collapse into 1 bucket. **The hash is applied only in
  `_drainFlagEvaluations` when serializing.** This means the raw value never
  crosses the process boundary — it exists only on the in-memory entry for the
  flush interval — and the crypto call runs once per unique bucket, not once
  per evaluation.

**Serialization change in `_drainFlagEvaluations`:**

```js
if (entry.targetingKey) {
  ev.targeting_key = entry.observeFullEvaluationData
    ? entry.targetingKey
    : FlagEvaluationsWriter.hashTargetingKey(entry.targetingKey)
}
```

Everything else stays as-is. The existing payload-limit `_degradeEventForPayloadLimit`
already strips `targeting_key` and `context` from oversized rows, so no change
is needed there.

## Tests

### New file: `hash_targeting_key.spec.js` (in `test/openfeature/writers/`)

- `matches the cross-SDK canonical vector` — `jane.doe@datadoghq.com` →
  `sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b`.
- `does not trim whitespace` — leading/trailing space yields a different digest.
- `does not case-fold` — `Jane` vs `jane` yields different digests.
- `does not Unicode-normalize` — NFC-composed vs NFD-decomposed yield different
  digests. Both variants written with explicit `\u` escapes.
- `handles empty string` — pins the `sha256_e3b0c...` digest.

### `agentless_configuration_source.spec.js` — new cases

- `parses observeFullEvaluationData=true at UFC root`
- `defaults observeFullEvaluationData to false when absent`
- `treats explicit null as false`
- Parametric fail-closed table over `[1, 0, 'true', 'false', [], {}, null]` —
  each resolves to `false`.
- `ignores observeFullEvaluationData nested inside environment` — this is the
  placement-drift guard.

### `flag_evaluations.spec.js` — new cases

- `hashes targeting_key when observeFullEvaluationData is false`
- `preserves raw targeting_key when observeFullEvaluationData is true`
- `omits context when observeFullEvaluationData is false` (asserted on the
  emitted event object, not on the aggregation entry).
- `separates buckets by consent value` — same subject, two consent values,
  two full-tier buckets.
- `consent-off buckets share one entry across distinct contexts` — regression
  guard for `concern:consent-off-bucket-keying` (Java pilot lesson: the bucket
  key must not carry dimensions the wire event drops).
- `AND-folds consent on merge as defense in depth` — construct a scenario where
  two events with the same bucket key have different consent values (would
  require a bug for the key to collide, but the AND-fold makes it safe anyway).
- `hashes once per bucket at flush cadence, not per evaluation` — spy on
  `createHash` and assert call count equals unique full-tier buckets, not
  evaluation count.
- `raw wire negative control` — assert that the raw targeting-key string does
  not appear anywhere in the serialized payload bytes when consent is off, and
  no PII context attribute value appears either. Byte-string search, not
  decode-and-inspect (a decode misses raw values that route into unexpected
  fields).
- `degraded tier emits no raw targeting_key or context under either consent`.

### `flag_eval_evp_hook.spec.js` — new cases

- `reads consent from the provider snapshot at hook entry, not later`
- `skips context capture entirely when consent is off` — assert the writer
  received `attrs === {}` even though `hookContext.context` was populated.
- `fails closed when snapshot is undefined` (initial-config-not-yet-received).

### `flagging_provider.spec.js` — end-to-end

- `setConfiguration flows observeFullEvaluationData into writer output`
- **Consent-lifecycle guard.** Evaluate flag → replace snapshot with opposite
  consent → flush → assert the flushed event shows the evaluation-time consent,
  not the post-swap value. Both directions covered. This is the single most
  important regression test in this PR; the Java pilot shipped this bug and L3
  caught it, not unit tests.
- `DoLog non-impact` — for each consent value, flushed-event JSON is identical
  across `doLog ∈ {true, false}`.
- `kill switch prevents construction` — with
  `DD_FLAGGING_EVALUATION_COUNTS_ENABLED=false`, neither writer nor EVP hook is
  registered on the provider, regardless of UFC consent value.

### `remote_config.spec.js` — new cases

- Mirror the agentless parse tests for the RC-delivered configuration path
  (same UFC schema; consent value must land on the same snapshot).

## Out of scope

- **System-tests (L3).** JS's `manifests/nodejs.yml` currently deactivates the
  entire `test_flag_eval_evp.py` file with `missing_feature (FFL-2446)`. This
  PR does not activate it. A follow-up `system-tests` change flips the file on
  and marks only the three `Test_FFE_EVP_Flagevaluation_ObserveFullData_*` rows
  as `missing_feature (FFL-2965)`. Tracked separately.
- **L2 dogfooding.** No companion `ffe-dogfooding` change in this PR.
- **Upstream evaluator metadata stamping.** A follow-up may move the consent
  stamp into `@datadog/openfeature-node-server` so the JS side deletes the
  provider `_snapshot` and reads `evaluationDetails.flagMetadata.observe_full_evaluation_data`
  directly. Not required for this PR.
- **Public OpenFeature `flagMetadata` exposure of `observe_full_evaluation_data`.**
  The Java pilot exposes this on `ProviderEvaluation`; a cross-SDK decision on
  whether to surface it publicly in JS is deferred (`concern:public-flagmetadata`
  from Go PR #4886). This PR keeps the value internal.
- **Config surface.** No new env vars. The kill switch
  `DD_FLAGGING_EVALUATION_COUNTS_ENABLED` and its config mapping are already
  in place; verified.

## Risks

- **Default-hashed on upgrade.** Any customer dashboard/query that reads
  `targeting_key` verbatim will start seeing `sha256_`-prefixed values as soon
  as this ships. Mitigation: the base track has not shipped yet in JS, so the
  first release JS customers see already carries hashing by default — no
  behavior change from an intermediate raw-PII release.
- **Cross-SDK contract drift.** A future refactor that adds trim, case fold, or
  Unicode normalization silently breaks the cross-SDK subject-count join. The
  canonical vector test plus non-normalization parametric tests are the primary
  guards.
- **Consent-lifecycle regression.** The Java pilot shipped a flush-time consent
  read bug that unit tests missed and L3 caught. JS's L3 is not activated by
  this PR, so the consent-lifecycle guard in
  `flagging_provider.spec.js` carries more weight than usual. It must exercise
  the actual swap-between-evaluate-and-flush path, not just the read path.
- **Stacked-PR merge risk.** This branch targets
  `leo.romanovsky/ffl-2446-evp-flagevaluation-nodejs`, not `master`. Reviewers
  must resolve base-track changes back into this branch as the base moves.
  Alternative (fold into base track) was rejected for reviewability; the
  stacking is explicit in the PR body.

## Design Decisions (log)

| Decision | Chosen | Alternative | Reason |
| --- | --- | --- | --- |
| Where hashing lives | Static method on `FlagEvaluationsWriter` | Standalone `writers/hash_targeting_key.js` module | Small, single-callsite; keeps the hash contract discoverable next to its only consumer. Canonical-vector test targets the static method directly. |
| Consent snapshot boundary | `FlagEvalEVPHook.finally` reading provider snapshot | Upstream evaluator stamps `flagMetadata` | Upstream `@datadog/openfeature-node-server` v2.0.2 does not stamp today. Hook boundary gives the same lifecycle guarantee (synchronous with evaluation). Upstream stamp is a follow-up. |
| Hash cadence | At flush, once per full-tier bucket | Per evaluation in `enqueue` | Aggregation collapses N evaluations with the same subject into 1 bucket → 1 hash call, not N. Matches Python. Raw value never crosses process boundary — lives on the in-memory entry for the flush interval only. |
| Snapshot representation | Single `Object.freeze({...})` reference | Two fields (`_config`, `_consent`) | Prevents torn reads. Matches Python `NamedTuple` and Go atomic pointer swap. |
| Consent in the bucket key | Yes, leading position | Post-aggregation filter | Prevents mixed-consent merges by construction. AND-fold is only defense in depth. |
| PR sequencing | Stacked on base track PR | Fold into base track PR | User preference; easier review; will merge into base before base merges to master, so customers never see a raw-PII release. |
