'use strict'

const assert = require('node:assert/strict')

const RedisPlugin = require('../../../packages/datadog-plugin-redis/src/index')

const { VARIANT } = process.env

const ITERATIONS = 12_000_000

// Eight realistic redis command shapes covering 0 / 1 / 4 / many args, the
// AUTH short-circuit, and a long-arg case that exercises the 1000-char trim.
const COMMANDS = [
  ['PING', undefined],
  ['GET', ['session:user:1234567']],
  ['SET', ['session:user:1234567', 'value-with-medium-length']],
  ['HSET', ['hash:user:1234567', 'name', 'Alice', 'email', 'alice@example.com', 'age', 30]],
  ['ZADD', ['leaderboard', 100, 'player1', 200, 'player2', 300, 'player3']],
  ['MGET', ['key1', 'key2', 'key3', 'key4', 'key5']],
  ['LPUSH', ['list:queue', JSON.stringify({ id: 1, payload: 'x'.repeat(50) })]],
  ['AUTH', ['password-redacted-by-plugin']],
]

// Plugin reads `this.config.filter` / `this.serviceName` / `this.startSpan` via
// the inheritance chain. Stubbing them on the instance bypasses the tracer
// plumbing while keeping the production `bindStart` shape intact. `startSpan`
// touches the meta literal so V8 cannot DCE its construction.
let sink = 0
const plugin = Object.create(RedisPlugin.prototype)
plugin.config = { filter: () => true }
plugin.system = 'redis'
plugin._spanType = 'redis'
plugin.serviceName = () => 'redis'
plugin.startSpan = (opts) => {
  sink ^= opts.meta['db.type'].length
  sink ^= opts.meta['redis.raw_command'].length
}

const buildCtx = (command, args) => ({
  db: '0',
  command,
  args,
  connectionOptions: { host: '127.0.0.1', port: 6379 },
  connectionName: undefined,
})

// Pre-flight: confirm `bindStart` actually reaches the meta-literal path.
const ctx = buildCtx('GET', ['key'])
plugin.bindStart(ctx)
assert.notEqual(sink, 0, 'redis bindStart did not exercise startSpan with the expected meta')

if (VARIANT === 'mixed-commands') {
  const len = COMMANDS.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const [command, args] = COMMANDS[iteration % len]
    plugin.bindStart(buildCtx(command, args))
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
} else if (VARIANT === 'long-args') {
  // Worst-case: a single SET with a 5KB value. Exercises the per-character
  // accumulation in `formatCommand` until the 1000-char trim trips, on every
  // iteration.
  const longCtx = buildCtx('SET', ['key:large', 'x'.repeat(5000)])
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    plugin.bindStart(longCtx)
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
}
