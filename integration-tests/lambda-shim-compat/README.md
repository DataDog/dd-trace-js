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
using the five pinned runtime images in `assets/images.json`. With today's package metadata:

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

CI mode reports `PASS WITH KNOWN FAILURES` only for these exact defects, reproduced by the released
control in the same run. The machine-readable expectations are in `scripts/gate.cjs`:

- **Explicit npm re-wrapping:** `datadog(datadog(handler))` returns a different wrapper and emits two
  nested shim spans and two invocation metrics, with one handler call and one child. The timeout
  monitor hides the shim's `_ddWrapped` marker when handing the wrapper back to the shim. Both
  5.126.0 and 6.15.0 reproduce this. The exception pins counts, ownership and nesting; it cannot
  permit two unrelated traces, an additional plugin span, or duplication in ordinary invocations.
- **ESM timeout hooks:** `redirect-esm` and `layer-esm` promise/callback/frozen timeout cases never
  flush their invocation or unfinished child in this harness. Both must be absent, while invocation
  results, active context, and metrics still pass. Preloading the tracer does not repair these ESM
  hook paths. Any partial/different flush or additional failure is red.
- **Mixed-layer custom extraction:** only `normal/layer-{cjs,esm}/custom-config` loses the supplied
  parent when the layer and task load separate tracer module copies. The emitted invocation is a
  root with a different trace ID, but payload capture, active headers and child parenting work.
  The equivalent pure-layer cases must pass. Random IDs are compared as explicit relationships,
  not normalized away in raw output.

These failures were present in the 2026-09-28 pre-CI audit and were rechecked against released
controls while adding this gate. They remain defects, not successful compatibility cases. Fix them
in their owning change, add regression coverage, and remove the corresponding expectation. If the
control starts passing, a failing candidate is immediately red. Unknown shared failures and changed
failure shapes are also red; aggregate pass counts never override an individual regression.

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

## Remaining release evidence

This gate does not run RIE/goldens, simulate AWS process termination, deploy functions, validate
real HTTP response streaming, verify Datadog ingestion, or certify AppSec/profiling/native modules.
Those remain separate golden and deployed release checks. The final-preview shim also needs its
own migration-feature checks; it must not replace this backward-compatibility baseline.
