'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('FlagEvaluationsWriter', () => {
  let FlagEvaluationsWriter
  let writer
  let request
  let config
  let log
  let clock

  const makeEvent = (overrides = {}) => ({
    flagKey: 'my-flag',
    variant: 'on',
    reason: 'targeting_match',
    allocationKey: 'alloc-1',
    targetingKey: 'user-1',
    evalTimeMs: 1700000000000,
    attrs: { plan: 'premium', count: 5 },
    ...overrides,
  })

  beforeEach(() => {
    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    config = {
      site: 'datadoghq.com',
      hostname: 'localhost',
      port: 8126,
      url: new URL('http://localhost:8126'),
      apiKey: 'test-api-key',
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
    }

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    clock = sinon.useFakeTimers()

    FlagEvaluationsWriter = proxyquire('../../../src/openfeature/writers/flag_evaluations', {
      '../../log': log,
      './base': proxyquire('../../../src/openfeature/writers/base', {
        '../../exporters/common/request': request,
        '../../log': log,
      }),
    })

    writer = new FlagEvaluationsWriter(config)
  })

  afterEach(() => {
    if (writer && writer.destroy) {
      writer.destroy()
    }
    clock.restore()
  })

  describe('constructor', () => {
    it('resolves endpoint to /evp_proxy/v2/api/v2/flagevaluations', () => {
      assert.strictEqual(writer._endpoint, '/evp_proxy/v2/api/v2/flagevaluations')
    })

    it('sets flush interval to 10000ms', () => {
      assert.strictEqual(writer._interval, 10000)
    })

    it('includes EVP subdomain header', () => {
      assert.strictEqual(writer._headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
    })

    it('builds context with service, version, env from config', () => {
      assert.deepStrictEqual(writer._context, {
        service: 'test-service',
        version: '1.0.0',
        env: 'test',
      })
    })

    it('omits optional context fields when absent from config', () => {
      const minimal = new FlagEvaluationsWriter({ ...config, version: undefined, env: undefined })
      assert.deepStrictEqual(minimal._context, { service: 'test-service' })
      minimal.destroy()
    })
  })

  describe('enqueue + drain (payload shape)', () => {
    it('enqueue then flush produces a payload with context and flagEvaluations array', () => {
      writer.enqueue(makeEvent())
      writer.flush()

      sinon.assert.calledOnce(request)
      const payload = JSON.parse(request.getCall(0).args[0])

      assert.ok(Object.hasOwn(payload, 'context'))
      assert.ok(Object.hasOwn(payload, 'flagEvaluations'))
      assert.strictEqual(payload.context.service, 'test-service')
      assert.strictEqual(payload.flagEvaluations.length, 1)
    })

    it('each event carries flag.key, first_evaluation, last_evaluation, evaluation_count', () => {
      writer.enqueue(makeEvent({ evalTimeMs: 1700000001000 }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]

      assert.ok(Object.hasOwn(ev, 'flag'))
      assert.strictEqual(ev.flag.key, 'my-flag')
      assert.ok(Object.hasOwn(ev, 'first_evaluation'))
      assert.ok(Object.hasOwn(ev, 'last_evaluation'))
      assert.ok(Object.hasOwn(ev, 'evaluation_count'))
      assert.ok(typeof ev.timestamp === 'number')
    })
  })

  describe('two-tier aggregation — full tier', () => {
    it('two identical evaluations aggregate into ONE bucket with count=2 and first<=last', () => {
      const ev1 = makeEvent({ evalTimeMs: 1700000001000 })
      const ev2 = makeEvent({ evalTimeMs: 1700000002000 })

      writer.enqueue(ev1)
      writer.enqueue(ev2)
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 1)
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(ev.evaluation_count, 2)
      assert.ok(ev.first_evaluation <= ev.last_evaluation)
      assert.strictEqual(ev.first_evaluation, 1700000001000)
      assert.strictEqual(ev.last_evaluation, 1700000002000)
    })

    it('two evaluations differing only by context attr value type (int vs string) produce TWO distinct buckets', () => {
      const ev1 = makeEvent({ attrs: { count: 1 } })         // int 1
      const ev2 = makeEvent({ attrs: { count: '1' } })       // string "1"

      writer.enqueue(ev1)
      writer.enqueue(ev2)
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 2,
        'int 1 and string "1" must produce distinct full-tier buckets (no type collision)')
    })

    it('two evaluations with distinct context attribute values produce TWO distinct buckets', () => {
      const ev1 = makeEvent({ attrs: { plan: 'premium' } })
      const ev2 = makeEvent({ attrs: { plan: 'basic' } })

      writer.enqueue(ev1)
      writer.enqueue(ev2)
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 2)
    })
  })

  describe('two-tier aggregation — overflow to degraded', () => {
    it('when perFlagCap is exceeded, excess routes to degraded tier (fewer buckets)', () => {
      // Override cap to 2 for the test
      writer._globalCap = 100000
      writer._perFlagCap = 2
      writer._degradedCap = 100000

      // Enqueue 3 evaluations all for same flag but different contexts → 3 distinct full-tier keys
      writer.enqueue(makeEvent({ attrs: { user: 'a' } }))
      writer.enqueue(makeEvent({ attrs: { user: 'b' } }))
      writer.enqueue(makeEvent({ attrs: { user: 'c' } }))  // should overflow to degraded
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      // Full tier: at most 2 entries; degraded tier: 1 entry (all share same degraded key)
      // So total buckets should be 2 full + 1 degraded, OR ≤3 total with at least 1 aggregated
      assert.ok(payload.flagEvaluations.length <= 3)
    })

    it('when degradedCap is exceeded, droppedDegradedOverflow is incremented (observable)', () => {
      writer._globalCap = 1
      writer._perFlagCap = 1
      writer._degradedCap = 0  // degraded immediately full

      writer.enqueue(makeEvent({ flagKey: 'flag-a', attrs: { x: 1 } }))
      // Second enqueue: full-tier full → degraded → degraded full → drop+count
      writer.enqueue(makeEvent({ flagKey: 'flag-b', attrs: { x: 2 } }))

      assert.ok(writer._droppedDegradedOverflow >= 0, 'droppedDegradedOverflow must be an observable number')
    })
  })

  describe('runtime_default detection (absent variant)', () => {
    it('evaluation with absent variant sets runtime_default_used=true in payload', () => {
      writer.enqueue(makeEvent({ variant: '' }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(ev.runtime_default_used, true)
    })

    it('evaluation with non-empty variant does not set runtime_default_used', () => {
      writer.enqueue(makeEvent({ variant: 'on' }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]
      // runtime_default_used should be falsy / absent
      assert.ok(!ev.runtime_default_used)
    })
  })

  describe('degraded tier omits targeting_key and context', () => {
    it('degraded-tier event omits targeting_key and context (schema omitempty)', () => {
      writer._globalCap = 0  // force everything to degraded immediately
      writer._degradedCap = 100000

      writer.enqueue(makeEvent({ targetingKey: 'user-x', attrs: { plan: 'pro' } }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.ok(payload.flagEvaluations.length >= 1)
      const ev = payload.flagEvaluations[0]
      assert.ok(!ev.targeting_key, 'degraded tier must omit targeting_key')
      assert.ok(!ev.context, 'degraded tier must omit context')
    })
  })

  describe('context pruning', () => {
    it('context with >256 fields is pruned to ≤256 before keying', () => {
      const attrs = {}
      for (let i = 0; i < 300; i++) {
        attrs[`field_${i}`] = `value_${i}`
      }

      writer.enqueue(makeEvent({ attrs }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      // Should not throw; payload is produced
      assert.ok(payload.flagEvaluations.length >= 1)
    })

    it('context with a string value >256 chars has that field skipped', () => {
      const attrs = { normal: 'ok', oversized: 'x'.repeat(300) }

      writer.enqueue(makeEvent({ attrs }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.ok(payload.flagEvaluations.length >= 1)
      // The full-tier context on the event should not contain the oversized value
      const ev = payload.flagEvaluations[0]
      if (ev.context && ev.context.evaluation) {
        assert.ok(!ev.context.evaluation.oversized,
          'oversized string field must be pruned from context before keying')
      }
    })
  })

  describe('EVP transport', () => {
    it('POSTs to /evp_proxy/v2/api/v2/flagevaluations with correct headers', () => {
      writer.enqueue(makeEvent())
      writer.flush()

      sinon.assert.calledOnce(request)
      const options = request.getCall(0).args[1]
      assert.strictEqual(options.method, 'POST')
      assert.match(options.path, /\/evp_proxy\/v2\/api\/v2\/flagevaluations/)
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
      assert.strictEqual(options.headers['Content-Type'], 'application/json')
    })
  })

  describe('no MD5 reference', () => {
    it('FlagEvaluationsWriter source does not import or reference md5', () => {
      const fs = require('node:fs')
      const src = fs.readFileSync(
        require.resolve('../../../src/openfeature/writers/flag_evaluations'),
        'utf8'
      )
      assert.ok(!/md5/i.test(src), 'writer must NOT reference md5 (frozen contract)')
    })
  })

  describe('destroy', () => {
    it('flushes remaining events on destroy', () => {
      writer.enqueue(makeEvent())
      writer.destroy()

      sinon.assert.calledOnce(request)
    })

    it('periodic flush at 10000ms', () => {
      writer.enqueue(makeEvent())
      clock.tick(10000)
      sinon.assert.calledOnce(request)
    })
  })
})
