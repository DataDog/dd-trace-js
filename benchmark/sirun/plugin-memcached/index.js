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

// Each variant fixes the client/server topology and rotates a corpus of queries
// with varied key/command lengths. In the hashring variant the differing key
// lengths also land on different servers (HashRing.get keys on key.length), so
// the multi-server resolution branch runs over changing inputs, not one key.
const GET_QUERIES = [
  { type: 'get', command: 'get user:1234567', key: 'user:1234567' },
  { type: 'set', command: 'set session:abcdef0123 0 0 64', key: 'session:abcdef0123' },
  { type: 'get', command: 'get cart:99887766', key: 'cart:99887766' },
  { type: 'delete', command: 'delete token:aabbccddeeff', key: 'token:aabbccddeeff' },
]
const HASHRING_QUERIES = [
  { type: 'get', command: 'get session:abcdef', key: 'session:abcdef', redundancyEnabled: false },
  { type: 'get', command: 'get user:1234567:profile', key: 'user:1234567:profile', redundancyEnabled: false },
  { type: 'get', command: 'get f', key: 'f', redundancyEnabled: false },
  { type: 'get', command: 'get inventory:sku-5566', key: 'inventory:sku-5566', redundancyEnabled: false },
]

const VARIANTS = {
  get: { client: { servers: ['cache-1.internal:11211'] }, server: 'cache-1.internal:11211', queries: GET_QUERIES },
  hashring: { client: hashringClient, server: undefined, queries: HASHRING_QUERIES },
}

const topology = VARIANTS[VARIANT]
assert.ok(topology, `unknown VARIANT: ${VARIANT}`)

// startSpan is stubbed, so bindStart never writes ctx.currentStore; the corpus of
// ctxs is pre-built once and rotated, so the loop allocates nothing per iteration.
const ctxs = topology.queries.map((query) => ({ client: topology.client, server: topology.server, query }))
const len = ctxs.length

lastMeta = undefined
plugin.bindStart(ctxs[0])
assert.ok(lastMeta && typeof lastMeta['out.host'] === 'string', 'bindStart did not resolve the server address')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctxs[i % len])
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
