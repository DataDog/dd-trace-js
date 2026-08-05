'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const RedisPlugin = require('../../../packages/datadog-plugin-redis/src/index')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// Every traced redis command walks `bindStart`: command.toUpperCase(), the
// config filter, the per-connection service cache, then formatCommand to build
// `redis.raw_command`, and startSpan. Subclassing the real plugin and overriding
// only the tracer-reaching hooks keeps the production bindStart shape while
// pulling the measured surface back to the per-command normalization and
// raw-command formatting.
let lastMeta
const FAKE_SPAN = { finish () {} }
class BenchedRedisPlugin extends RedisPlugin {
  addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
  serviceName () { return 'redis-prod' }
  startSpan (options) { lastMeta = options.meta; return FAKE_SPAN }
  getPeerService () {}
}

const tracer = {
  _service: 'web-app',
  _nomenclature: { config: {}, opName: () => 'redis.command' },
}
const tracerConfig = { spanComputePeerService: false }
const plugin = new BenchedRedisPlugin(tracer, tracerConfig)
plugin.configure({ enabled: true, service: 'redis-prod' })

const CONN = { host: 'redis-primary.internal', port: 6379 }

// Representative command shapes:
// - get/set: the overwhelmingly common case, short args
// - hset: several field/value pairs
// - long-value set: a value past MAX_ARG_LENGTH, hits per-arg truncation
// - mset-wide: many args, hits MAX_COMMAND_LENGTH truncation
const LONG_VALUE = 'x'.repeat(250)
// 80 key/value pairs build a raw command past the 1000-char MAX_COMMAND_LENGTH,
// so this variant exercises the command-level truncation branch (60 pairs land
// at ~944 chars, short of the cutoff).
const WIDE_ARGS = []
for (let i = 0; i < 80; i++) WIDE_ARGS.push('key:' + i, 'value:' + i)

const COMMANDS = {
  get: { command: 'get', args: ['user:1234567:profile'] },
  set: { command: 'set', args: ['session:abcdef', 'active', 'EX', 3600] },
  hset: { command: 'hset', args: ['user:1234567', 'name', 'Jane', 'email', 'jane@example.com', 'age', 42] },
  'long-value': { command: 'set', args: ['blob:1', LONG_VALUE] },
  'mset-wide': { command: 'mset', args: WIDE_ARGS },
}

const MIXED = ['get', 'set', 'hset', 'get', 'set', 'get'].map((k) => COMMANDS[k])

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

function preflight (ctx) {
  lastMeta = undefined
  plugin.bindStart(ctx)
  assert.ok(lastMeta && typeof lastMeta['redis.raw_command'] === 'string',
    'bindStart did not build the raw_command meta')
}

guard.loopStart()
if (VARIANT === 'churn') {
  // Rebuild the ctx getStartCtx allocates per command instead of reusing one:
  // the only variant that pays that per-command allocation, isolating the GC
  // cost the reuse variants hoist out of the loop.
  const cmd = COMMANDS.get
  preflight(makeCtx(cmd))
  lastMeta = undefined
  for (let i = 0; i < OPERATIONS; i++) {
    plugin.bindStart(makeCtx(cmd))
  }
} else if (VARIANT === 'mixed') {
  const ctxs = MIXED.map(makeCtx)
  for (const ctx of ctxs) preflight(ctx)
  lastMeta = undefined
  const len = ctxs.length
  for (let i = 0; i < OPERATIONS; i++) {
    plugin.bindStart(ctxs[i % len])
  }
} else {
  const cmd = COMMANDS[VARIANT]
  assert.ok(cmd, `unknown VARIANT: ${VARIANT}`)
  const ctx = makeCtx(cmd)
  preflight(ctx)
  if (VARIANT === 'mset-wide') {
    assert.equal(lastMeta['redis.raw_command'].length, 1000,
      'mset-wide should hit MAX_COMMAND_LENGTH truncation (raw_command capped at 1000)')
  }
  lastMeta = undefined
  for (let i = 0; i < OPERATIONS; i++) {
    plugin.bindStart(ctx)
  }
}

assert.ok(lastMeta, 'startSpan stub was never reached inside the hot loop')
guard.done()
