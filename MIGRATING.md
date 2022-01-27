# Migrating

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

### Outgoing request filtering

Outgoing request filtering is no longer supported and is now only available for
incoming requests. This means that the `blocklist` and `allowlist` options on
the `http` integration no longer have any effect.
