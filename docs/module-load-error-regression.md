# Failed module loads and Lambda cold-start capture

## PR description draft

### What does this PR do?

Balance RITM module-load start/end events and clear the in-progress marker when
`require()` throws, while preserving the original exception and successful-load
behavior. Add regression tests for failed loads, retries, loader registration,
and the IAST subscriber.

### Motivation

`datadog-lambda-js` has a cold-start tracing feature that emits spans describing
initialization and individual module loads. It builds the module-loading tree
from dd-trace's start/end events.

**Expected behavior:** a failed module load that the application or tracer catches
must not break capture of subsequent successful loads. Each published start needs
a matching end so subscribers can finish their load stacks.

**Current behavior:** with Node 22.23.2, released dd-trace 6.15.0, and Lambda's
default `--no-experimental-require-module` flag, the application runs successfully
but its cold-start module spans are missing.

**Root cause:** dd-trace's registration code tries to load an ES-module helper
using `require()` to determine whether it can use synchronous loader hooks. With
`--no-experimental-require-module`, that operation throws `ERR_REQUIRE_ESM`.
Registration catches it and correctly falls back to asynchronous loader
registration. However, RITM publishes a start without an end for the failed load
and leaves its in-progress marker set. The shim's subscriber retains an unfinished
stack, trapping subsequent module loads in an incomplete tree.

### Additional Notes

**This intentionally changes the end-event contract:** subscribers can now receive
`dd-trace:moduleLoadEnd` for a failed load, with no `module` property or exports.
An end event means the load attempt completed, not that it succeeded. The original
exception still propagates; failed loads do not run module patchers. IAST security
controls also consume these events, so a regression test explicitly verifies that
their existing no-exports guard safely ignores failed-load events.

The regression fails against the original implementation and passes with the fix.
Focused module-load/registration tests pass on Node 18/20/22/24/26. All seven
cold-start integration cases pass on Node 22/24/26 arm64 with only the fixed RITM
file overlaid on released dd-trace. Existing ESM goldens remain unchanged, and an
ESM HTTP instrumentation probe passes. These are local container checks, not
deployed AWS verification or a complete architecture matrix.

## Implementation details

With Node 22.23.2 and dd-trace 6.15.0, Lambda's
`--no-experimental-require-module` flag makes the ES-module helper's `require()`
in `register.js` throw `ERR_REQUIRE_ESM`. This is a synchronous-loader capability
probe; registration catches the error and correctly selects the asynchronous loader.

RITM previously published `dd-trace:moduleLoadStart` before the failed require,
but never published `dd-trace:moduleLoadEnd` or cleared the `patching` marker.
The datadog-lambda-js subscriber therefore retained an unfinished stack frame.
Subsequent application module events were published but could not become completed
roots in the cold-start tree. This is not an asynchronous loader bypassing RITM.

The fix publishes the matching end event and clears the marker in `finally`.
Failed loads have no `module` property, preserve the original thrown value, and
do not run module patchers. Successful loads retain the existing end-subscriber
export replacement behavior. A subsequent successful retry remains instrumented.
IAST's existing no-exports guard ignores failed-load end events.

No changes to loader registration, runtime flags, dependencies, or shim behavior
are required. The same failure cleanup is relevant to caught module-evaluation
errors outside Lambda and should be backported to supported tracer release lines.

## Focused checks

```sh
./node_modules/.bin/mocha \
  packages/dd-trace/test/ritm.spec.js \
  packages/dd-trace/test/ritm-loader.spec.js \
  packages/dd-trace/test/appsec/iast/security-controls/index.spec.js
```

- Nested evaluation failures, including throwing `undefined`, keep start/end
  events correctly nested and preserve exception identity.
- Repeated failures and a successful retry check in-progress marker cleanup.
- Successful export replacement and cyclic dependencies retain existing tests.
- Child processes exercise real registration with default Node flags and, when
  supported, `--no-experimental-require-module`, then load CJS and ESM fixtures.
- IAST explicitly accepts an end event without exports.

The new nested-failure test was run against the original source and failed with
two unfinished stack frames. The fixed source passes. On local Node 25, the
combined suite passes 32 tests. The RITM and loader suites also pass in Lambda
Node 18/20/22/24/26 containers (10 tests on Node 18, 11 on each newer runtime).
Changed-file lint and whitespace checks pass. The existing cyclic fixture emits
Node's circular-dependency warning but its assertions pass.

## Shim integration validation

The separate `dlj-cold-start-tests` worktree tests merged shim main `174c0d47`.
For Node 22/24/26 arm64 RIE validation, only this file was bind-mounted read-only
over the released dd-trace 6.15.0 file:

```text
packages/dd-trace/src/ritm.js
  npm image:   /var/task/node_modules/dd-trace/packages/dd-trace/src/ritm.js
  layer image: /opt/nodejs/node_modules/dd-trace/packages/dd-trace/src/ritm.js
```

The released file and the fixed file differ only in the load-error cleanup hunk.
No installed source was overwritten. The RIE harness used
`SKIP_PACK=true RIE_HTTP_TRANSPORT=container` and the appropriate `RUNTIME_PARAM`
and `CASE_PARAM`; snapshot update mode was not used.

All seven new cold-start cases pass on each of Node 22/24/26 arm64: enabled npm,
enabled layer, skip-library, high threshold, disabled, provisioned, and managed.
Each case exercises nine invocations, including cold initialization, a warm lazy
require, and subsequent warm calls. Existing `container-esm` and `layer-esm`
goldens pass on all three runtimes, plus `container-cjs` on Node 22.
The existing `integration-tests/init/instrument.mjs` HTTP probe also reports an
instrumentation event under Node 22's `--no-experimental-require-module` flag.
Separate unmodified-release controls pass enabled npm, enabled layer, and
skip-library cases on Node 18/20 arm64 with dd-trace 5.126.0. Those control runs
do not validate a v5 backport of this fix.

This is a one-file fix validation, not a full migration candidate parity run.
It does not certify deployed AWS behavior or the complete architecture matrix.
The shim tests still need fixed tracer release pins before merging without an
overlay; the local fix does not change those pins or publish a release.
