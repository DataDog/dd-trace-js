'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const MemcachedPlugin = require('../../../packages/datadog-plugin-memcached/src/index')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 6_000_000

// Every traced memcached command walks `bindStart`: resolve the server address
// (directly, or via the client HashRing when the server is not pinned), build
// the meta bag, and start the span. Subclass the real plugin and override only
// the tracer-reaching hooks so the measured surface is the address resolution
// and meta assembly.
let lastMeta
const FAKE_SPAN = { finish () {}, setTag () {} }
class BenchedMemcachedPlugin extends MemcachedPlugin {
  addSub () {}
  addBind () {}
  serviceName () { return 'memcached-prod' }
  startSpan (...args) {
    const opts = args.find((a) => a && a.meta)
    lastMeta = opts?.meta
    return FAKE_SPAN
  }
}

const tracer = { _service: 'web-app', _env: 'prod', _version: '1.0.0' }
const plugin = new BenchedMemcachedPlugin(tracer, { spanComputePeerService: false })
plugin.configure({ enabled: true, service: 'memcached-prod', DD_TRACE_MEMCACHED_COMMAND_ENABLED: true })

// HashRing stand-in: a real memcached client picks a server for a key by
// consistent hashing. Mirror that surface (servers list + HashRing.get) so the
// hashring variant exercises the multi-server resolution branch.
const SERVERS = ['cache-1.internal:11211', 'cache-2.internal:11211', 'cache-3.internal:11211']
const hashringClient = {
  servers: SERVERS,
  redundancy: false,
  HashRing: {
    get (key) { return SERVERS[key.length % SERVERS.length] },
  },
}

const VARIANTS = {
  get: {
    client: { servers: ['cache-1.internal:11211'] },
    server: 'cache-1.internal:11211',
    query: { type: 'get', command: 'get user:1234567', key: 'user:1234567' },
  },
  hashring: {
    client: hashringClient,
    server: undefined,
    query: { type: 'get', command: 'get session:abcdef', key: 'session:abcdef', redundancyEnabled: false },
  },
}

const v = VARIANTS[VARIANT]
assert.ok(v, `unknown VARIANT: ${VARIANT}`)

// startSpan is stubbed, so bindStart never writes ctx.currentStore; one ctx can
// be reused across iterations without per-iteration allocation skewing the loop.
const ctx = { client: v.client, server: v.server, query: v.query }

lastMeta = undefined
plugin.bindStart(ctx)
assert.ok(lastMeta && typeof lastMeta['out.host'] === 'string', 'bindStart did not resolve the server address')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctx)
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
