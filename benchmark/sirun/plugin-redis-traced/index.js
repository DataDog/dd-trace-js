'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// Full traced redis command, end to end. Where the isolated plugin-redis bench
// stubs startSpan to measure only the meta assembly, this drives the real tracer
// and the real redis plugin over the diagnostic channels the instrumentation
// uses, so each iteration pays the whole per-command cost: bindStart meta build,
// span start, context entry via runStores, span finish and the real processor
// (priority/span sampling, git-metadata tagging, span formatting and stats).
// Only the exporter is swapped for a no-op, so the processor still formats and
// erases each finished trace but nothing is buffered, encoded, or leaves the
// process.
const tracer = require('../../..').init()
tracer._tracer._processor._exporter = { export () {} }

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
// This is the heaviest per-iteration loop in the suite (a full span lifecycle
// through the real processor), so the instruction-counting pass on the stable
// machine scales steeply with the count: ~600k overran the one-minute budget,
// 450k keeps the variant under it while staying deterministic. At that count the
// fixed full-tracer init still settles around 15% of the run -- pushing it below
// 10% would need a count that overruns the budget -- so allow an 18% startup share.
guard.done(0.18)
