'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const DatabasePlugin = require('../../src/plugins/database')

function makeSpan (tags = {}) {
  return {
    context: () => ({ _tags: tags }),
    setTag () {},
    _spanContext: { toTraceparent: () => '00-aaa-bbb-01' },
    _processor: { sample () {} },
  }
}

describe('DatabasePlugin DBM caching', () => {
  let plugin
  let tracer
  let encodeSpy

  beforeEach(() => {
    tracer = {
      _service: 'svc',
      _env: 'tester',
      _version: '1.0.0',
    }
    plugin = new DatabasePlugin(tracer, {})
    plugin._tracerConfig = {}
    plugin.configure({ dbmPropagationMode: 'service', enabled: true })
  })

  afterEach(() => {
    encodeSpy?.restore()
    encodeSpy = undefined
  })

  it('captures dde / ddps / ddpv at configure time, not on every query', () => {
    const span = makeSpan({ 'db.name': 'mydb', 'out.host': 'host1' })
    const first = plugin.createDbmComment(span, 'svc')

    assert.strictEqual(
      first,
      "dddb='mydb',dddbs='svc',dde='tester',ddh='host1',ddps='svc',ddpv='1.0.0'"
    )

    // Mutating the tracer's globals after configure must not affect the comment — the
    // immutable suffix is baked in once. The original implementation re-read every field
    // on every query.
    tracer._env = 'shifted-env'
    tracer._service = 'shifted-svc'
    tracer._version = '2.0.0'

    assert.strictEqual(plugin.createDbmComment(span, 'svc'), first)
  })

  it('reuses the cached prefix across queries on the same (db, host, dbmService)', () => {
    // Non-ASCII forces the `encodeURIComponent` path; the fast path skips ASCII inputs
    // entirely, so we'd otherwise observe zero calls regardless of caching.
    encodeSpy = sinon.spy(globalThis, 'encodeURIComponent')
    const span = makeSpan({ 'db.name': 'müll', 'out.host': 'höst' })

    plugin.createDbmComment(span, 'sërvice')
    const callsAfterMiss = encodeSpy.callCount
    assert.ok(callsAfterMiss >= 3, 'first call encodes db.name, host, and serviceName')

    plugin.createDbmComment(span, 'sërvice')
    plugin.createDbmComment(span, 'sërvice')
    assert.strictEqual(encodeSpy.callCount, callsAfterMiss,
      'cache hit must not encode again on identical (db, host, dbmService)')

    plugin.createDbmComment(makeSpan({ 'db.name': 'andërer', 'out.host': 'höst' }), 'sërvice')
    assert.ok(encodeSpy.callCount > callsAfterMiss,
      'cache miss when db.name changes must re-encode')
  })

  it('skips encodeURIComponent for unreserved RFC 3986 characters', () => {
    encodeSpy = sinon.spy(globalThis, 'encodeURIComponent')
    const span = makeSpan({ 'db.name': 'safe-name.~_db', 'out.host': '127.0.0.1' })

    const comment = plugin.createDbmComment(span, 'safe-svc')
    assert.match(comment, /dddb='safe-name\.~_db'/)
    assert.match(comment, /ddh='127\.0\.0\.1'/)
    assert.match(comment, /dddbs='safe-svc'/)
    assert.strictEqual(encodeSpy.callCount, 0, 'fast path bypasses encodeURIComponent')
  })

  it('falls back to encodeURIComponent on reserved characters', () => {
    const span = makeSpan({ 'db.name': 'a&b', 'out.host': 'h$' })
    const comment = plugin.createDbmComment(span, 'sv c')

    assert.match(comment, /dddb='a%26b'/)
    assert.match(comment, /ddh='h%24'/)
    assert.match(comment, /dddbs='sv%20c'/)
  })

  it('configure() rebuilds the immutable suffix so reconfigured tracer fields take effect', () => {
    const span = makeSpan({ 'db.name': 'mydb', 'out.host': 'host1' })
    assert.match(plugin.createDbmComment(span, 'svc'), /dde='tester'/)

    tracer._env = 'newenv'
    plugin.configure({ dbmPropagationMode: 'service', enabled: true })

    assert.match(plugin.createDbmComment(span, 'svc'), /dde='newenv'/)
  })

  it('appends ddprs= when peer-service is in scope', () => {
    const span = makeSpan({ 'db.name': 'mydb', 'out.host': 'host1' })
    plugin.getPeerService = () => ({
      'peer.service': 'downstream-svc',
      '_dd.peer.service.source': 'peer.service',
    })

    const comment = plugin.createDbmComment(span, 'svc')
    assert.match(comment, /,ddprs='downstream-svc'$/)
  })

  it('bounds the prefix cache so high-cardinality db.name cannot grow it without bound', () => {
    // Boundary test for the LRU cap (DBM_PREFIX_CACHE_MAX = 256 in database.js). Insert
    // CAP + 1 unique keys without re-accessing intermediate ones, so the first-inserted key
    // is the LRU and gets evicted when the CAP-th unique insertion lands.
    const CAP = 256
    encodeSpy = sinon.spy(globalThis, 'encodeURIComponent')

    for (let i = 0; i <= CAP; i++) {
      plugin.createDbmComment(makeSpan({ 'db.name': `dëb-${i}`, 'out.host': 'höst' }), 'svc')
    }
    const callsAfterFill = encodeSpy.callCount

    plugin.createDbmComment(makeSpan({ 'db.name': `dëb-${CAP}`, 'out.host': 'höst' }), 'svc')
    assert.strictEqual(encodeSpy.callCount, callsAfterFill,
      'most-recently inserted key must remain cached')

    plugin.createDbmComment(makeSpan({ 'db.name': 'dëb-0', 'out.host': 'höst' }), 'svc')
    assert.ok(encodeSpy.callCount > callsAfterFill,
      'least-recently-used key must have been evicted at the cap')
  })
})
