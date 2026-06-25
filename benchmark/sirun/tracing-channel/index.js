'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const guard = require('../startup-guard')
const TracingPlugin = require('../../../packages/dd-trace/src/plugins/tracing')

const OPERATIONS = Number(process.env.OPERATIONS)

// Every instrumented operation, regardless of integration, is dispatched into the
// plugin through the diagnostic channels the Plugin base binds/subscribes to: the
// start channel runs the store binding (bindStart), the finish channel notifies the
// subscription (finish). This bench isolates that generic dispatch cost with a real
// TracingPlugin whose handlers do nothing integration-specific. Per-plugin benches
// call their own handler directly, so the dispatch is measured once, here.
let started = 0
let finished = 0
class DispatchPlugin extends TracingPlugin {
  static id = 'bench'
  static operation = 'op'

  bindStart (ctx) {
    started++
    return ctx.currentStore
  }

  finish () {
    finished++
  }
}

const tracer = {
  _nomenclature: { serviceName: () => 'bench', opName: () => 'bench.op', config: {} },
}
const plugin = new DispatchPlugin(tracer, {})
plugin.configure({ enabled: true })

// The channels the plugin bound to in its constructor (apm:<id>:<operation>:<event>).
const startChannel = dc.channel('apm:bench:op:start')
const finishChannel = dc.channel('apm:bench:op:finish')
const NOOP = () => {}
const ctx = { resource: 'op' }

// Verify the dispatch reaches both handlers before timing, so broken wiring fails
// loudly instead of measuring an empty publish.
startChannel.runStores(ctx, NOOP)
finishChannel.publish(ctx)
assert.ok(started > 0 && finished > 0, 'tracing-channel dispatch did not reach the plugin handlers')

guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  startChannel.runStores(ctx, NOOP)
  finishChannel.publish(ctx)
}

assert.ok(started > OPERATIONS && finished > OPERATIONS, 'tracing-channel dispatch produced no handler calls')
guard.done()
