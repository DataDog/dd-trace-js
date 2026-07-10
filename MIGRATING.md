# Migrating

This guide describes the steps to upgrade dd-trace from a major version to the
next. If you are having any issues related to migrating, please feel free to
open an issue or contact our [support](https://www.datadoghq.com/support/) team.

## 6.0 to 7.0 (unreleased)

### `headerTags` prefers an object over an array

The `headerTags` programmatic option and the per-plugin `headers` option
(`http`, `http2`, the web frameworks) now take an object keyed by header
name, matching the other mapping-style options (`serviceMapping`,
`peerServiceMapping`). An empty tag name falls back to
`http.{request,response}.headers.<header>`.

The legacy `['header:tag']` array (and comma-separated string) still works at
runtime — it is converted to an object and logs a one-time deprecation
warning — and will be removed in a future major. `DD_TRACE_HEADER_TAGS`
keeps parsing the same `'header:tag,header:tag'` string.

```js
// Deprecated (still works, warns once)
tracer.init({ headerTags: ['x-user-id:user.id', 'x-team'] })
tracer.use('http', { client: { headers: ['x-user-id:user.id', 'x-team'] } })

// Preferred
tracer.init({ headerTags: { 'x-user-id': 'user.id', 'x-team': '' } })
tracer.use('http', { client: { headers: { 'x-user-id': 'user.id', 'x-team': '' } } })
```

As a drive-by, the `http2` client now honors custom tag names in this option
like the `http` and web integrations already did; previously it tagged every
configured header as `http.{request,response}.headers.<header>` and dropped
the custom tag name.

## 5.0 to 6.0

### Node 18 and 20 are no longer supported

Node.js 18 reached EOL in April 2025 and Node.js 20 reached EOL in April 2026;
neither is supported in v6. We highly recommend always keeping Node.js up to
date regardless of our support policy.

### Minimum versions bumped for test framework integrations

Make sure to update any of the below frameworks to a v6 supported minimum version.

| Framework  | v5 minimum | v6 minimum |
| :---:      | :---:      | :---:      |
| Jest       | 24.8.0     | 28.0.0     |
| Mocha      | 5.2.0      | 8.0.0      |
| Cypress    | 6.7.0      | 12.0.0     |
| Playwright | 1.18.0     | 1.38.0     |

### Nx service name default value

The `NX_TASK_TARGET_PROJECT` environment variable set automatically by `nx`
is now used as the default test service name `test.service` unless
`DD_SERVICE` is explicitly set. On v5 this behavior required
`DD_ENABLE_NX_SERVICE_NAME` to opt in. Remove the opt-in variable if you had
it set; the behavior is now unconditional.

### Lage test session name default value

The `LAGE_PACKAGE_NAME` environment variable set automatically by `lage` is
now used as the default test session name `test_session.name` unless
`DD_TEST_SESSION_NAME` is explicitly set. On v5 this behavior required
`DD_ENABLE_LAGE_PACKAGE_NAME=true` to opt in. Remove the opt-in variable if
you had it set; the behavior is now unconditional.

### CI test session `test_session.name` is now the trimmed command

The `test_session.name` tag on test session spans now defaults to only the
framework invocation (e.g. `jest`, `mocha`, `playwright test`, `cucumber-js`)
rather than the full command line, when no explicit name is otherwise
configured. The `test.command` tag is unaffected and still
contains the full command. Update any monitors or dashboards that matched on
`test_session.name` with the full command string.

### OpenAI span resource name is now the normalized method name

The `resource.name` on `openai.request` spans now uses a normalized,
SDK-version-independent name (e.g. `createChatCompletion`) instead of the raw
SDK method name (e.g. `chat.completions.create`). Update any monitors or
dashboards that matched on the dotted v4 SDK method names.

### IAST security controls is env-only

`iast.securityControlsConfiguration` (and the legacy alias
`experimental.iast.securityControlsConfiguration`) is no longer accepted as a
programmatic option. Set `DD_IAST_SECURITY_CONTROLS_CONFIGURATION` instead.

### Plugin `whitelist` and `blacklist` options removed from types

The deprecated `whitelist` / `blacklist` plugin options on the `http`, `ioredis`,
`iovalkey`, and `redis` plugin interfaces are no longer part of the v6 TypeScript
surface. Use `allowlist` / `blocklist` instead — both have been the canonical
names for several majors.

### `Span.addTags` only accepts plain objects

`Span.addTags` historically dispatched on a `'key:val,key:val'` string
or an array (of strings, arrays, or objects, recursively) on top of the
documented `{ [key]: value }` form. Neither shape ever appeared in the
public TypeScript surface and no v6 caller passes one. v6 drops both
paths: `addTags` is now a thin `Object.assign` onto the span's tag map.
Convert string or array inputs to plain objects at the call site before
calling `addTags`.

```js
// Before (still works on v5)
span.addTags('env:prod,version:1.2.3')

// After
span.addTags({ env: 'prod', version: '1.2.3' })
```

### `Span.addLink(spanContext, attributes)` legacy overload removed

`Span.addLink` (both the OpenTracing-style API and the OpenTelemetry bridge)
no longer accepts a positional `(spanContext, attributes)` form. Pass the
single-argument shape instead: `addLink({ context, attributes })`.

```js
// Before (still works on v5)
span.addLink(otherSpan.context(), { foo: 'bar' })

// After
span.addLink({ context: otherSpan.context(), attributes: { foo: 'bar' } })
```

### `DD_TRACE_STARTUP_LOGS` defaults to `true`

Startup configuration is logged to the console by default. Set
`DD_TRACE_STARTUP_LOGS=false` to silence it.

### `experimental.iast` configuration removed

The `experimental.iast.*` programmatic aliases have been removed. Use the
canonical top-level `iast.*` fields and `DD_IAST_*` environment variables
instead.

### AppSec extended-data-collection programmatic config removed from types

`appsec.extendedHeadersCollection.{enabled,redaction,maxHeaders}` and
`appsec.rasp.bodyCollection` are no longer part of the v6 TypeScript surface.
Configure these features through the Datadog UI and Remote Configuration
instead — the runtime keeps consuming the values pushed by RC.

The matching `DD_APPSEC_COLLECT_ALL_HEADERS`,
`DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED`,
`DD_APPSEC_MAX_COLLECTED_HEADERS`, and `DD_APPSEC_RASP_COLLECT_REQUEST_BODY`
environment variables are deprecated in v6 and will follow in a future major.

### `experimental.b3` removed

The `experimental.b3` programmatic flag and `DD_TRACE_EXPERIMENTAL_B3_ENABLED`
env var are gone. Configure b3 propagation via `DD_TRACE_PROPAGATION_STYLE`
directly (see the renamed-style note below).

### Profiling experimental aliases removed

`DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED`,
`DD_PROFILING_EXPERIMENTAL_CPU_ENABLED`,
`DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED`, and
`DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED` are gone. Use the canonical names
without the `_EXPERIMENTAL_` segment.

### `DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED` removed

Use `DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED` instead.

### `"b3 single header"` propagation style renamed to `"b3"`

The historical `'b3'` value used to mean multi-header; per the OTel `b3`
propagator spec, `'b3'` now means single-header. Multi-header propagation is
the existing `'b3multi'` value. The legacy `'b3 single header'` spelling is
still accepted on `DD_TRACE_PROPAGATION_STYLE` and the programmatic option as
a quiet alias for `'b3'`; prefer the canonical `'b3'` going forward.

### `experimental.appsec` configuration removed

The `experimental.appsec.*` programmatic aliases (and
`experimental.appsec.standalone.enabled`) have been removed. Use the canonical
top-level `appsec.*` fields, and `apmTracingEnabled` (or
`DD_APM_TRACING_ENABLED`) to control standalone ASM mode.

### `ingestion` option removed

The `ingestion: { sampleRate, rateLimit }` wrapper has been removed. Set
`sampleRate` and `rateLimit` directly on the top-level `TracerOptions` object,
or use `DD_TRACE_SAMPLE_RATE` / `DD_TRACE_RATE_LIMIT`.

### GraphQL resolver `depth` no longer counts list indices

The `graphql` plugin's `depth` option counted a resolver's full execution path,
including the numeric list indices that `collapse` folds away. The same query
therefore reached a different depth depending on whether `collapse` was enabled:
a field one list-hop below the limit was instrumented with `collapse: false` and
dropped with the default `collapse: true`.

v6 counts only selection-set nesting (named fields) toward `depth`, so the limit
tracks query structure rather than execution artifacts and is independent of
`collapse`. At a given `depth`, a resolver nested under a list is now reached one
level sooner than on v5's default. Lower `depth` to restore the previous cutoff.

## 4.0 to 5.0

### Node 16 is no longer supported

Node.js 16 has reached EOL in September 2023 and is no longer supported. Generally
speaking, we highly recommend always keeping Node.js up to date regardless of
our support policy.

### Update `trace<T>` TypeScript declaration

The TypeScript declaration for `trace<T>` has been updated to enforce
that calls to `tracer.trace(name, fn)` must receive a function which takes at least
the span object. Previously the span was technically optional when it should not have
been as the span must be handled.

## 3.0 to 4.0

### Node 14 is no longer supported

Node.js 14 has reached EOL in April 2023 and is no longer supported. Generally
speaking, we highly recommend always keeping Node.js up to date regardless of
our support policy.

### The `orphanable` option was removed

This option was only useful internally for a single integration that has since
been removed. It was never useful for manual instrumentation since all that is
needed to orphan a span on creation is to use
`tracer.trace('web.request', { childOf: null })`.

### Support for `jest-jasmine2` has been removed

The default test runner for Jest was changed to `jest-circus` around 2 years ago and
is no longer supported by our Jest integration for CI Visibility. We recommend
switching to `jest-circus` to anyone still using `jest-jasmine2`.

### Support for older Next.js versions was removed

We now support only Next.js 10.2 and up.

## 2.0 to 3.0

### Node 12 is no longer supported

Node.js 12 has been EOL since April 2022 and is no longer supported. Generally
speaking, we highly recommend always keeping Node.js up to date regardless of our
support policy.

### HTTP query string reported by default

HTTP query strings are now reported by default as part of the `http.url` tag.
This change is considered breaking only because there might be sensitive data
in the query string. A default regular expression based obfuscator is provided
for common use cases like API keys, but if your use case is not covered, the
[DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP](https://datadoghq.dev/dd-trace-js/#tracer-settings)
environment variable can be used to control what is obfuscated, and a value of
`.*` would redact the query string entirely.

### HTTP operation name change

The HTTP integration now uses `web.request` for incoming requests and continues
to use `http.request` for outgoing requests. When using a supported web
framework like Express, this change will have no effect because the root span
would already have an operation name override like `express.request`.
Any [monitor](https://docs.datadoghq.com/monitors/create/types/apm/?tab=apmmetrics)
on `http.request` for incoming requests should be updated to `web.request`.

With this change, both operation names also appear under the main service name
and are no longer split between the server service name and a separate client
service name suffixed with `-http-client`.

### gRPC operation name change

The gRPC integration now uses `grpc.server` for incoming requests and
`grpc.client` for outgoing requests. Any
[monitor](https://docs.datadoghq.com/monitors/create/types/apm/?tab=apmmetrics)
on `grpc.request` should be updated to one of these.

With this change, both operation names also appear under the main service name
and are no longer split between the server service name and a separate client
service name suffixed with `-http-client`.

### Removal of `fs` integration

The `fs` integration was removed as it was originally added without an actual
use case, and it's been problematic ever since. It's noisy, the output is
confusing when using streams, errors that are handled higher in the stack end up
being captured, etc.

If you had any use for file system instrumentation, please let us know so we can
provide an alternative.

### Scope binding for promises and event emitters

It's no longer possible to bind promises using `tracer.scope().bind(promise)` or
event emitters using `tracer.scope().bind(emitter)`. These were historically
added mostly for internal use, and changes to context propagation over the years
made them unnecessary, both internally and externaly. If one of these is used
anywhere, the call will simply be ignored and no binding will occur.

To bind the `then` handler of a promise, bind the function directly directly:

```js
promise.then(tracer.scope().bind(handler))
```

To bind all listeners for an event, wrap the call to `emit` directly instead:

```js
tracer.scope().activate(span, () => {
  emitter.emit('event')
})
```

To bind individual listeners, bind the listener function directly instead:

```js
emitter.on('event', tracer.scope().bind(listener, span))
```

### Removed APIs

The following APIs have been deprecated for a long time and have now been
completely removed:

- `tracer.currentSpan()`
- `tracer.bindEmitter()`

Since these have not been recommended nor publicly documented for years at this
point, there should be no impact as no application is expected to be using them.

### CI Visibility new entrypoints

#### Cypress

`dd-trace/cypress/plugin` and `dd-trace/cypress/support` are removed, so you won't
be able to use them for your `cypress` instrumentation. Use `dd-trace/ci/cypress/plugin`
and `dd-trace/ci/cypress/support` instead for your plugin and support configuration
respectively.

#### Jest

The use of `'dd-trace/ci/jest/env'` in [`testEnvironment`](https://jestjs.io/docs/configuration#testenvironment-string)
is no longer supported.
To instrument `jest` tests now, add `'-r dd-trace/ci/init'` to the `NODE_OPTIONS` environment
variable passed to the process running the tests, for example, `NODE_OPTIONS='-r dd-trace/ci/init' yarn test`.

#### Mocha

The use of `--require dd-trace/ci/init` as a `mocha` flag is no longer supported.
To instrument `mocha` tests now, add `'-r dd-trace/ci/init'` to the `NODE_OPTIONS` environment
variable passed to the process running the tests, for example, `NODE_OPTIONS='-r dd-trace/ci/init' yarn test`.

#### Cucumber

The use of `--require-module dd-trace/ci/init` as a `cucumber-js` flag is no longer supported.
To instrument `cucumber-js` tests now, add `'-r dd-trace/ci/init'` to the `NODE_OPTIONS` environment
variable passed to the process running the tests, for example, `NODE_OPTIONS='-r dd-trace/ci/init' yarn test`.

## 1.0 to 2.0

### Configuration

The following configuraton options are no longer available programmatically and
must be configured using these environment variables:

* `enabled` -> `DD_TRACE_ENABLED=true|false`
* `debug` -> `DD_TRACE_DEBUG=true|false`

If environment variables were already used for these options, no action is
needed.

The following configuration options were completely removed and will no longer
have any effect:

* `scope`

Startup logs are now disabled by default and can be enabled if needed with
`DD_TRACE_STARTUP_LOGS=true`.

### Removed APIs

The original scope manager has been replaced several years ago and has now been
removed. Any code referencing `tracer.scopeManager()` should be removed or
replaced with `tracer.scope()` which is documented
[here](https://datadoghq.dev/dd-trace-js/#scope-manager).

### Nested objects as tags

Support for nested objects as tags as been removed. When adding an object as a
tag value, only properties that exist on that object directly will be added as
tags. If nested properties are also needed, these should be added by hand.

For example:

```js
const obj = {
  a: 'foo',
  b: {
    c: 'bar'
  }
}

// 1.0
span.setTag('test', obj) // add test.a and test.b.c

// 2.0
span.setTag('test', obj) // add test.a
span.setTag('test.b', obj.b) // add test.b.c
```

Arrays are no longer supported and must be converted to string manually.

### Outgoing request filtering

Outgoing request filtering is no longer supported and is now only available for
incoming requests. This means that the `blocklist` and `allowlist` options on
the `http` integration no longer have any effect.
