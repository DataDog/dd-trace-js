# Migrating

This guide describes the steps to upgrade dd-trace from a major version to the
next. If you are having any issues related to migrating, please feel free to
open an issue or contact our [support](https://www.datadoghq.com/support/) team.

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
The way to instrument your `jest` tests now is by passing the `NODE_OPTIONS='-r dd-trace/ci/init'`
environment variable to the process running the tests.

#### Mocha

The use of `--require dd-trace/ci/init` as a `mocha` flag is no longer supported. 
The way to instrument your `mocha` tests now is by passing the `NODE_OPTIONS='-r dd-trace/ci/init'`
environment variable to the process running the tests.

#### Cucumber

The use of `--require-module dd-trace/ci/init` as a `cucumber-js` flag is no longer supported.
The way to instrument your `cucumber-js` tests now is by passing the `NODE_OPTIONS='-r dd-trace/ci/init'`
environment variable to the process running the tests.

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
