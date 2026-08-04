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
const { storage } = require('../../../packages/datadog-core')

const OPERATIONS = Number(process.env.OPERATIONS)

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

const startCh = channel('apm:dns:lookup:start')
const finishCh = channel('apm:dns:lookup:finish')

// runStores only propagates context when a store is bound; a subscriber alone makes it
// a pass-through. Bind the tracer's async-context store the way TracingPlugin.addTraceBind
// does -- start enters a store carrying the span (DNSLookupPlugin.bindStart), finish
// restores the parent (OutboundPlugin.bindFinish) -- so the loop pays the real per-lookup
// propagation cost. The subscribers keep hasSubscribers true and drive the assertions.
const legacyStorage = storage('legacy')
const span = {} // stand-in for the span the plugin binds; the bench isolates propagation, not span creation

let started = 0
let finished = 0
startCh.subscribe(() => { started++ })
finishCh.subscribe(() => { finished++ })
startCh.bindStore(legacyStorage, (ctx) => {
  ctx.parentStore = legacyStorage.getStore()
  ctx.currentStore = { ...ctx.parentStore, span }
  return ctx.currentStore
})
finishCh.bindStore(legacyStorage, (ctx) => ctx.parentStore)

let lastResult
const onLookup = (_, address) => { lastResult = address }

// Before timing, confirm the wrapper dispatches through both channels, captures the
// result, and that the bound stores actually propagate context: the start bind enters a
// store carrying the span, the finish bind restores the parent. This fails loudly if an
// edit drops a binding instead of silently measuring a no-op pass-through again.
let storeInLookup
let storeInCallback
const verifyLookup = lookup(buildArgsContext)((hostname, callback) => {
  storeInLookup = legacyStorage.getStore()
  return callback(null, '127.0.0.1', 4)
})
verifyLookup('localhost', (_, address) => {
  lastResult = address
  storeInCallback = legacyStorage.getStore()
})
assert.ok(started > 0 && finished > 0, 'dns lookup wrapper did not reach the channels')
assert.equal(lastResult, '127.0.0.1', 'dns lookup wrapper did not deliver the result')
assert.equal(storeInLookup?.span, span, 'start bind did not propagate the span store')
assert.equal(storeInCallback, undefined, 'finish bind did not restore the parent store')

// Drift guard: buildArgsContext mirrors buildCallbackArgsContext() in dns.js (not
// exported). Assert it still drops the trailing callback and captures the rest, so
// the mirror can't silently diverge from the production arg-capture shape.
assert.deepEqual(
  buildArgsContext(null, ['localhost', 4, () => {}]),
  { args: ['localhost', 4] },
  'buildArgsContext mirror drifted from buildCallbackArgsContext'
)

guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  wrappedLookup('localhost', onLookup)
}
guard.done()

assert.ok(started > OPERATIONS && finished > OPERATIONS, 'dns lookup wrapper produced no work')
