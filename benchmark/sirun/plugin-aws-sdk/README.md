This benchmark measures the per-AWS-SDK-call work in
`packages/datadog-plugin-aws-sdk/src/base.js` and the EventBridge / Lambda service
plugins. Every traced AWS SDK call hits this code, so per-call savings compound for a
large customer subset.

The plugin internals are exercised directly via `Object.create(Plugin.prototype)` so
the hot loop never touches diagnostic channels or a real tracer; a tiny stub
`tracer.inject` populates the carrier the same way the real propagator would.
