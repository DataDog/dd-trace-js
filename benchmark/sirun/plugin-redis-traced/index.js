'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// Full traced redis command, end to end. Where the isolated plugin-redis bench
// stubs startSpan to measure only the meta assembly, this drives the real tracer
// and the real redis plugin over the diagnostic channels the instrumentation
// uses, so each iteration pays the whole per-command cost: bindStart meta build,
// span start, context entry via runStores, span finish and the processor. The
// processor is replaced with one that erases the trace on finish, so spans are
// built and finished but nothing accumulates, encodes, or leaves the process.
const tracer = require('../../..').init()
tracer._tracer._processor.process = function process (span) {
  this._erase(span.context()._trace)
}

const RedisPlugin = require('../../../packages/datadog-plugin-redis/src/index')
const { channel } = require('../../../packages/datadog-instrumentations/src/helpers/instrument')

// Construct the real plugin against the real tracer + tracer config (the pair the
// plugin manager would pass) and enable it, which subscribes bindStart/bindFinish
// to the redis channels. tracer.use('redis') alone would not: the plugin only
// subscribes once the redis module loads, and there is no client here.
const plugin = new RedisPlugin(tracer, tracer._pluginManager._tracerConfig)
plugin.configure({ enabled: true, service: 'redis-prod' })

const startCh = channel('apm:redis:command:start')
const finishCh = channel('apm:redis:command:finish')

const ITERATIONS = Number(process.env.ITERATIONS) || 450_000

const CONN = { host: 'redis-primary.internal', port: 6379 }
const COMMANDS = [
  { command: 'get', args: ['user:1234567:profile'] },
  { command: 'set', args: ['session:abcdef', 'active', 'EX', 3600] },
  { command: 'hset', args: ['user:1234567', 'name', 'Jane', 'email', 'jane@example.com'] },
  { command: 'get', args: ['cart:99887766'] },
]
const len = COMMANDS.length

/**
 * A fresh per-command context, matching what the instrumentation's getStartCtx
 * allocates per call: runStores writes the span store onto it, so it cannot be
 * reused across commands.
 *
 * @param {{ command: string, args: unknown[] }} cmd
 */
function makeCtx (cmd) {
  return {
    db: 0,
    command: cmd.command,
    args: cmd.args,
    argsStartIndex: 0,
    connectionOptions: CONN,
    connectionName: 'default',
  }
}

const NOOP = () => {}

// Pre-flight: one full command must create, tag and finish a real span.
const preCtx = makeCtx(COMMANDS[0])
startCh.runStores(preCtx, NOOP)
const preSpan = preCtx.currentStore?.span
assert.ok(preSpan, 'start channel did not create a span (plugin not subscribed?)')
assert.equal(preSpan.context().getTag('db.type'), 'redis', 'span is missing the redis meta')
finishCh.publish(preCtx)
assert.ok(preSpan._duration !== undefined, 'finish channel did not finish the span')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  const ctx = makeCtx(COMMANDS[i % len])
  startCh.runStores(ctx, NOOP)
  finishCh.publish(ctx)
}
// This is the heaviest per-iteration loop in the suite (a full span lifecycle), so
// the instruction-counting pass on the stable machine scales steeply with the count:
// 1.5M overran the one-minute budget at ~2m40s. 450k keeps the variant well under it
// while staying deterministic. The two ceilings squeeze each other -- dwarfing the
// fixed full-tracer init below 10% would need ~600k iterations, which puts the
// instruction pass back over a minute -- so at the count that fits the budget the
// init settles around 15% of the run; allow an 18% startup share to clear it.
guard.done(0.18)
