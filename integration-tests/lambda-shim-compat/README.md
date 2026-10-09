# Pre-migration Lambda shim compatibility

This is the **existing-shim backward-compatibility gate**, not the final-preview migration test.
It installs a real, frozen `datadog-lambda-js` package alongside a tarball built from the candidate
checkout and runs the same process probes against a pinned released tracer control. No tracer,
shim, or timeout timer is mocked. Test containers have no network access.

## CI and release branches

`.github/workflows/lambda-shim-compat.yml` runs on PRs targeting `master`, `v6.x`, or `v5.x`, pushes
to those branches and their configured merge-queue branches, and manual dispatch. There is no
new nightly or notification job. The existing Serverless workflow is unchanged.

The workflow builds the checkout once and tests that exact tarball. It never checks out unchanged
release heads and calls that backport coverage. Cherry-pick the implementation **and this gate**
to each release line; each backport PR tests its own merge revision. Require the stable
`lambda-shim-compat` job in branch protection/rulesets on all three branches; adding this file
does not configure those repository settings.

The runtime matrix is selected from the candidate's unmodified `engines.node` and `nodeMaxMajor`,
using the five pinned runtime images in `assets/images.json`. `nodeMaxMajor` is exclusive, matching
the tracer guardrails: that major and all newer majors are unsupported. With today's package metadata:

| Candidate | Runtime majors | Released control |
| --- | --- | --- |
| v5 backport | 18, 20, 22, 24, 26 | 5.126.0 |
| v6 backport | 22, 24, 26 | 6.15.0 |
| master / v7 preview | 22, 24, 26 | 6.15.0 |

The master pairing is experimental: v7 is outside the frozen shim's declared v5/v6 peer range.
It cannot certify the actual v5/v6 releases. No engine-range widening or `DD_INJECT_FORCE` is used.
CI is linux/amd64; ARM64 is available locally but is not another CI matrix dimension.

## Frozen inputs and provenance

`assets/datadog-lambda-js-12.143.0.tgz` is the unchanged, compiled pre-migration PR842 artifact
from shim commit `85fdb2ee2368e4ef03268277e01b9e99119ca4c1`, originally preserved by the
`lambda-shim-compat` audit harness. It is a locally packed release-candidate checkout, **not** a
downloaded published npm release. Its SHA-256 is checked before and after every run. This small
fixture is committed so CI does not depend on an agent skill directory or a mutable shim branch.
The tarball includes the upstream package's license. See `assets/baseline.json` for its identity.

Both released controls have committed, checksummed Yarn locks. Candidate transitive dependencies
resolve at install time; their generated locks are retained with the reports. Therefore this is
a pinned-shim gate, not a claim that every input is immutable. Dependency installation uses
`--ignore-scripts`: optional native installation behavior is outside this test's coverage.

For v5 comparisons, both candidate and control resolve `@aws-sdk/types` to `3.965.0`, which satisfies
the shim dependency ranges and supports Node 18. The unbounded transitive range otherwise resolves
to `3.974.6`, requiring Node 20 and preventing the v5 Node 18 leg from even starting. This fixture
resolution does not modify the frozen shim or tracer artifact and does not bypass engine checks.

Provenance records commit, dirty state, candidate tarball checksum, packaged Lambda source hashes,
fixture checksum, dependency lock checksums, image IDs/digests, runtime, and architecture. Installed
candidate Lambda files and package engine metadata are checked against the requested checkout.
CI uploads reports, raw process output and install logs even on failure, without node_modules or caches.

## Contract and known defects

Each runtime executes all **109 cases per artifact**: installed npm/redirect/mixed-layer (84), pure
layer with no task-local dependencies (20), and tracer-preloaded promise timeouts (5).
Coverage includes CJS/ESM entry points, callback/promise/context completion, exceptions, streaming
argument shape, frozen handlers, warm rejection cleanup, timeout flushing of an unfinished child,
custom extraction, propagation, custom/enhanced metrics, and metrics-only mode.

The assertion collector checks independent contracts even after one fails. It counts `aws.lambda`
spans across **all** trace payloads, checks shim ownership, matches the active invocation, validates
child parenting, and verifies that the timeout error is on the invocation rather than its child.

CI mode reports `PASS WITH KNOWN FAILURES` only for the exact defects below, reproduced by the
released control in the same run. Each exception in [gate.cjs](scripts/gate.cjs) links to a stable
tracking ID here; [gate.test.cjs](scripts/gate.test.cjs) pins the complete affected-case inventory.

These failures were present in the 2026-09-28 pre-CI audit and were rechecked against released
controls while adding this gate. They remain defects, not successful compatibility cases. Fix them
in their owning change, add regression coverage, and remove the corresponding expectation. If the
control starts passing, a failing candidate is immediately red. Unknown shared failures and changed
failure shapes are also red; aggregate pass counts never override an individual regression.

### Legacy defect register

These are repository-local follow-up records, **not GitHub issue numbers or assigned tickets**.
All three are **OPEN** in the legacy pairing; closure in the final-preview pairing is **unverified**.
The existing code-owner teams for this harness and Lambda core are `@DataDog/dd-trace-js`,
`@DataDog/serverless-aws`, and `@DataDog/apm-serverless` (see [CODEOWNERS](../../.github/CODEOWNERS)).
The component owners and roadmap checkpoints below route the work; they do not imply an accepted
personal assignment or a shipped fix.

| ID | Defect | Failing cases per runtime | Follow-up checkpoint |
| --- | --- | ---: | --- |
| [LEGACY-LAMBDA-001](#legacy-lambda-001) | Explicit npm re-wrapping duplicates spans/metrics | 1 | PR6 lifecycle follow-up; PR16 conversion proof |
| [LEGACY-LAMBDA-002](#legacy-lambda-002) | ESM timeout hooks do not flush | 11 | PR6 loader/timeout follow-up; PR16 conversion proof |
| [LEGACY-LAMBDA-003](#legacy-lambda-003) | Mixed-layer custom extraction loses its parent | 2 | PR8 extraction checkpoint; PR16 loader proof |

The 2026-10-02 actual-backport runs below reproduce all **14** cases on both released controls
and the supported v5/v6 candidates. This supports the narrow PR3 no-new-regression decision with
`DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS` unset. It does not make these defects acceptable post-migration,
prove safety for a changed failure shape, or authorize extending the exception list.

### LEGACY-LAMBDA-001

**Explicit npm re-wrapping — OPEN.** Component owner: dd-trace's npm hook/timeout-monitor seam
(`packages/dd-trace/src/lambda/{handler.js,runtime/patch.js}`), coordinating with the shim's
`datadog()` / `_ddWrapped` contract in `datadog-lambda-js/src/index.ts`.

- Reproducer: `normal/npm/repeat-wrap`, which calls `datadog(datadog(handler))`.
- Impact/evidence: wrapper identity changes; two nested shim-owned `aws.lambda` spans in **one**
  trace, three spans total, and two enhanced invocation metrics, despite one handler call and one
  child. The monitor hides the shim's marker when handing the wrapper back to the shim. This is
  distinct from PR3's fixed two-root/two-trace double-owner defect, which is never allowed.
- Follow-up: a separate lifecycle bug fix, not an incidental change in a mechanical port. Preserve
  the shim's idempotency contract without making handlers mutable or adding a second timer.
- Acceptance: repeated wrapping returns the same wrapper when `forceWrap` is not requested;
  exactly one shim-owned invocation span, one correctly parented child, one invocation metric and
  one handler call across **all** payloads. Add L1 siblings for frozen handlers, repeated hooks,
  timeout monitoring, and explicit `forceWrap`; retain npm/layer and final-preview coverage.
- Parity rows to reference in the shim's ledger: `Manual datadog(handler, config?) wrapping`,
  `Exactly one wrapper when layer + NODE_OPTIONS both active`, and `one lifecycle owner`.

### LEGACY-LAMBDA-002

**ESM timeout hooks do not flush — OPEN.** Component owner: dd-trace's Lambda hook registration
and timeout monitor, with the shim's `src/handler.mjs` / runtime loader owning ESM load ordering.

- Reproducers: `normal/{redirect-esm,layer-esm}/{timeout-promise,timeout-callback,timeout-frozen}`
  (6), `layer-only/layer-esm/{timeout-promise,timeout-callback,timeout-frozen}` (3), and
  `preload/{redirect-esm,layer-esm}/timeout-promise` (2).
- Impact/evidence: neither the invocation span nor its unfinished child is flushed. Handler
  results, active context and metrics still pass. Preloading the tracer does not repair these
  paths. The exact loader/hook failure mechanism still needs diagnosis; these process probes do
  not establish actual AWS termination behavior.
- Follow-up: trace loader registration, handler interception and monitor arming in the real ESM
  entry paths; fix the owning seam separately from the mechanical lifecycle port.
- Acceptance: every listed case flushes exactly one invocation and one unfinished child; only
  the invocation carries `error.type="Impending Timeout"`. Preserve CJS/npm cases, callback and
  frozen-handler behavior, metrics, and warm-container timer cleanup. Add L1 regression coverage;
  extend the timeout RIE/golden coverage and verify actual termination through the L3 release gate.
- Parity rows: `ESM handler loading`, `ESM loader registration + double-registration guard`, and
  `timeout behavior (impending-timeout error, killAll, flush deadline)`.

### LEGACY-LAMBDA-003

**Mixed-layer custom extraction loses its parent — OPEN.** Component owner: the cross-repo
loader/context seam. The shim selects/loads `DD_TRACE_EXTRACTOR` and resolves the tracer;
dd-trace must consume the resulting context consistently when task and layer load separate copies.

- Reproducers: `normal/{layer-cjs,layer-esm}/custom-config` (2). Equivalent pure-layer cases pass.
- Impact/evidence: the invocation starts a new trace with parent zero instead of the fixture's
  trace `1234` / parent `5678`. Payload capture, active headers and child parenting still work.
  Separate tracer copies are present; pinpoint the context producer/consumer mismatch before
  choosing a fix. Do not assume the custom extractor itself or async awaiting is the cause.
- Follow-up: investigate during the PR8 extraction checkpoint and retain PR16 loader coverage;
  keep any legacy behavior correction separate from the mechanical extractor port.
- Acceptance: both mixed-layer paths preserve trace `1234` and parent `5678`, emit exactly one
  invocation span with a correctly parented child, and retain payload/headers/metrics. Keep
  npm/redirect and pure-layer coverage; add an awaited async-extractor regression and module-copy
  identity checks. Removing the mixed-layer fixture is not a fix.
- Parity rows: `DD_TRACE_EXTRACTOR module loading`, `custom extractor, awaited`, and
  `extraction chain order + addTraceContextToXray`.

### Closure and exception removal

1. Reproduce the affected cases with the frozen shim and a freshly run control. The diagnostic
   `--filter repeat-wrap`, `--filter timeout`, or `--filter custom-config` options select these
   families; omit `--ci` for filtered runs. Record runtime, architecture, artifact hashes and raw
   results. A filtered run is not full release evidence.
2. Add the owning regression tests and run the full candidate/control matrix on actual v5/v6
   backports. Every case associated with the closing ID must pass all assertions; a released
   control may still fail. Keep unrelated known failures visible.
3. In the fix change, remove only that ID's expectation from `scripts/gate.cjs` and its affected
   entries from the inventory test. Keep the behavioral probes and assertions. Update this record
   to **FIXED** with fixing commit/PR, backport/release references and passing report locations;
   do not delete its historical ID.
4. If the fix requires a new shim, retain the frozen baseline until a separate, explicit baseline
   update/retirement decision. A final-preview pass alone cannot close the old-shim defect or
   justify deleting its exception. Track legacy and migrated verification separately.
5. At PR16, require all three contracts to pass with the actual final-preview shim and candidate
   tracer before removing the transition gate. Do not carry these exceptions into that pairing.
   Local process success does not replace candidate goldens, required CI or deployed release checks.

## Local use

The host driver requires Node 22.3+, npm, Git and Docker; the installed probes support Node 18+.
Use the normal repository dependency/build setup first so `vendor/dist` exists. On macOS, choose
a fresh Docker-shared output path under `/Users`, outside the candidate checkout.

```sh
npm run test:lambda:compat:unit
npm run test:lambda:compat -- --candidate /path/to/dd-trace \
  --output /path/outside/checkout/new-run --runtimes 22,24,26 --ci
```

For a v5 backport use `--runtimes 18,20,22,24,26`; the control is selected automatically from the
candidate major. `--tarball /path/to/prebuilt.tgz` tests an artifact built separately, as CI does.
Strict mode (omit `--ci`) returns 1 for **any** candidate failure, including known defects. Focused
`--filter`, `--modes`, and explicit `--control` are diagnostic options only; CI mode rejects them.
Exit 2 means setup/identity/incomplete-run failure, never compatibility success.

Read `report.md`, `summary.json`, `provenance.json`, and the individual `results-*.json` files.
Do not recapture the shim, change assertions, or extend expectations merely to make a run green.

## Actual backport validation — 2026-10-02

Fetched the release branches and applied the current PR3 feature diff in separate worktrees.
The source snapshot is `20bddf51` (PR3 `968b0b21` plus the local runtime-bound fix and
plugin-disable regression tests), not a v7 checkout with a changed package version.

| Release base | Local backport commit | Node runtimes | Candidate cases |
| --- | --- | --- | --- |
| v5.130.0 / `c8bc9be2` | `15b8a6eb` | 18.20.8, 20.20.2, 22.23.2, 24.20.0, 26.7.0 | 475 passing / 545 |
| v6.19.0 / `ee31dc7d` | `fea8a4f9` | 22.23.2, 24.20.0, 26.7.0 | 285 passing / 327 |

Both full, unfiltered linux/arm64 runs returned **PASS WITH KNOWN FAILURES**, with **zero
new, changed, or unexpected failures**. Every runtime had 95/109 candidate passes versus
83/109 released-control passes; the remaining 14 candidate failures matched the exact defects
documented above and were freshly reproduced by the control. They are not passing cases.
The frozen shim and expectations were not changed.

The branches are `joey/migrate-datadog-lambda-pr3-v5` and `joey/migrate-datadog-lambda-pr3-v6`.
Versions, engine bounds, dependency manifests and lockfiles remain those of the release bases.
The only cherry-pick conflict was generated config types; regenerating from each target's
merged schema resolved it without importing unrelated master settings. The Lambda implementation,
facade, plugin manager and config wiring match the source snapshot.

Reports, raw outputs, installed-source verification and provenance are retained beside the
checkouts in `lambda-backport-v5-20261002/` and `lambda-backport-v6-20261002/`.
Candidate tarball SHA-256 values:

- v5: `40f23409f225023a9b65f7c87ad78ce22a1ed8062e244899b044d98be8a6d9b0`
- v6: `7aa1b097a5177dae21244ea41110a37d9ab3ea9fb82e5c832003d9e7ee5d9a9a`

On host Node 25.8.0, each backport passed 110 Lambda lifecycle tests, 58 plugin-manager tests,
203 structure/instrumentation/plugin/utility tests and 23 harness tests. Config tests passed
384 with 9 existing skips on v5, and 390 with 3 existing skips on v6. Generated-config verification,
targeted lint and public type checks passed, including the v5 declaration surface substituted
as `index.d.ts` in the compiler host to model the release type swap without editing the checkout.
The complete v5 Lambda suite also passed all 110 tests on Node 18.20.8 in a disposable container
copy. The initial read-only run reached 109 passes but blocked the packing fixture: that image's
npm 10.8.2 runs `prepare` despite `--ignore-scripts`. Allowing preparation in the disposable copy
resolved the setup failure without changing the real checkout, test assertions or timeout.

An ad-hoc combined config/manager process hit six logger assertions on both the candidate and
unchanged v5 base `c8bc9be2`: config tests invalidate the cached logger while the manager spec
retains the old reference. The normal separate-process test layout passes. No assertion was
weakened and no unrelated production change was included.

The bundled strict compatibility skill was also run on v6/Node 22. It correctly returned failure
for the same 14 legacy defects; its two mixed-layer signature differences contain random trace
IDs, with the same lost-parent/root relationships in the raw payloads. That strict run is retained
in `lambda-backport-v6-skill-20261002/`, not relabeled as a pass.

These are **local backport artifacts**, packed on the host with `--ignore-scripts`, as requested by this gate.
The branches have not been pushed, and this does not claim GitHub/amd64 CI or release approval.
Backport PRs must still run their own required checks; any subsequent source change needs new evidence.

## Remaining release evidence

This gate does not run RIE/goldens, simulate AWS process termination, deploy functions, validate
real HTTP response streaming, verify Datadog ingestion, or certify AppSec/profiling/native modules.
Those remain separate golden and deployed release checks. The final-preview shim also needs its
own migration-feature checks; it must not replace this backward-compatibility baseline.
