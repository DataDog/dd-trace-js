'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// Every traced dns.lookup walks the callback instrumentor the dns instrumentation
// installs: capture the call args (minus the callback), open the start channel via
// runStores, wrap the user callback to capture the result and publish finish, then
// run the underlying lookup. The real getaddrinfo is a libuv syscall whose time
// swamps and destabilizes the tracer's added work, so -- like the fs and
// child_process benches -- we drive that wrapper over a no-op underlying lookup that
// invokes the callback synchronously, using the real instrumentor helper so the
// measured path can't drift from production.
const { createCallbackInstrumentor } =
  require('../../../packages/datadog-instrumentations/src/helpers/callback-instrumentor')
const { channel } = require('../../../packages/datadog-instrumentations/src/helpers/instrument')

const ITERATIONS = Number(process.env.ITERATIONS) || 8_000_000

// Mirrors buildCallbackArgsContext() in datadog-instrumentations/src/dns.js for the
// lookup shape (no rrtype): drop the trailing callback and capture the rest.
function buildArgsContext (_, args) {
  if (args.length < 2) return
  const captured = [...args]
  captured.pop()
  return { args: captured }
}

// No-op underlying lookup: deliver a representative localhost result synchronously so
// the loop measures the wrapper, never getaddrinfo.
function noopLookup (hostname, callback) {
  return callback(null, '127.0.0.1', 4)
}

const lookup = createCallbackInstrumentor('apm:dns:lookup', { captureResult: true })
const wrappedLookup = lookup(buildArgsContext)(noopLookup)

// Real subscribers so hasSubscribers is true and runStores does the
// context-propagation work the tracer pays in production.
let started = 0
let finished = 0
channel('apm:dns:lookup:start').subscribe(() => { started++ })
channel('apm:dns:lookup:finish').subscribe(() => { finished++ })

let lastResult
const onLookup = (_, address) => { lastResult = address }

// Confirm the wrapper dispatches through both channels and captures the result before
// timing, so broken wiring fails loudly instead of silently measuring a bypass.
wrappedLookup('localhost', onLookup)
assert.ok(started > 0 && finished > 0, 'dns lookup wrapper did not reach the channels')
assert.equal(lastResult, '127.0.0.1', 'dns lookup wrapper did not deliver the result')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  wrappedLookup('localhost', onLookup)
}
guard.done()

assert.ok(started > ITERATIONS && finished > ITERATIONS, 'dns lookup wrapper produced no work')
