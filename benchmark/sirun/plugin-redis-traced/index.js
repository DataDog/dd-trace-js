'use strict'

const assert = require('node:assert/strict')
const nock = require('nock')

const guard = require('../startup-guard')
const { createNativeSpanDrain } = require('../native-span-drain')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

// Full traced redis command, end to end. Where the isolated plugin-redis bench
// stubs startSpan to measure only the meta assembly, this drives the real tracer
// and the real redis plugin over the diagnostic channels the instrumentation
// uses, so each iteration pays the whole per-command cost: bindStart meta build,
// span start, context entry via runStores, span finish and the real processor
// (priority/span sampling, git-metadata tagging, span formatting and stats).
// The exporter is replaced with a collector so JS spans still format+erase and
// native spans can be periodically drained without measuring real network I/O.
const tracer = require('../../..').init({ hostname: '127.0.0.1', port: 8126 })
const nativeSpanDrain = createNativeSpanDrain(tracer)
tracer._tracer._processor._exporter = {
  export (spans) {
    nativeSpanDrain.addAll(spans)
  },
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

const OPERATIONS = Number(process.env.OPERATIONS)

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

async function main () {
  await nativeSpanDrain.drain()

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    const ctx = makeCtx(COMMANDS[i % len])
    startCh.runStores(ctx, NOOP)
    finishCh.publish(ctx)
    if (nativeSpanDrain.needsDrain()) await nativeSpanDrain.drain()
  }
  await nativeSpanDrain.drain()
  // Native mode is much heavier than the older baseline source at this count. Keep
  // the lower count for CI runtime, but relax the startup-share guard so the fast
  // baseline run records an A/B result instead of failing as benchmark setup.
  guard.done(0.50)
}

main()
