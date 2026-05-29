'use strict'

const assert = require('node:assert/strict')

const RedisPlugin = require('../../../packages/datadog-plugin-redis/src/index')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 8_000_000

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
const WIDE_ARGS = []
for (let i = 0; i < 60; i++) WIDE_ARGS.push('key:' + i, 'value:' + i)

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

if (VARIANT === 'mixed') {
  const ctxs = MIXED.map(makeCtx)
  for (const ctx of ctxs) preflight(ctx)
  lastMeta = undefined
  const len = ctxs.length
  for (let i = 0; i < ITERATIONS; i++) {
    plugin.bindStart(ctxs[i % len])
  }
} else {
  const cmd = COMMANDS[VARIANT]
  assert.ok(cmd, `unknown VARIANT: ${VARIANT}`)
  const ctx = makeCtx(cmd)
  preflight(ctx)
  lastMeta = undefined
  for (let i = 0; i < ITERATIONS; i++) {
    plugin.bindStart(ctx)
  }
}

assert.ok(lastMeta, 'startSpan stub was never reached inside the hot loop')
