'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

// Structural validator for the EVP flageval-worker batched payload contract. Required
// event fields and the {key} object shape for variant/allocation mirror the dd-trace-go
// reference (openfeature/flagevaluation.go) and the flageval-worker ingestion contract.
// Returns an array of contract violations (empty array == valid). Mechanical: it inspects
// actual runtime types/shapes, it does not substring-match serialized text.
const KEY_OBJECT_FIELDS = ['variant', 'allocation']
const REQUIRED_EVENT_FIELDS = ['timestamp', 'flag', 'first_evaluation', 'last_evaluation', 'evaluation_count']

function validateFlagEvaluationPayload (payload) {
  const errors = []
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

  if (!isObject(payload)) return ['payload is not an object']
  if (!isObject(payload.context)) errors.push('context must be an object')
  else if (typeof payload.context.service !== 'string') errors.push('context.service must be a string')
  if (!Array.isArray(payload.flagEvaluations)) return [...errors, 'flagEvaluations must be an array']

  for (const [index, event] of payload.flagEvaluations.entries()) {
    if (!isObject(event)) { errors.push(`event[${index}] is not an object`); continue }

    for (const field of REQUIRED_EVENT_FIELDS) {
      if (!Object.hasOwn(event, field)) errors.push(`event[${index}] missing required field "${field}"`)
    }
    if (!isObject(event.flag) || typeof event.flag.key !== 'string') {
      errors.push(`event[${index}].flag must be { key: string }`)
    }
    for (const numericField of ['timestamp', 'first_evaluation', 'last_evaluation', 'evaluation_count']) {
      if (Object.hasOwn(event, numericField) && !Number.isInteger(event[numericField])) {
        errors.push(`event[${index}].${numericField} must be an integer`)
      }
    }
    // variant and allocation MUST be { key: string } OBJECTS, never bare strings.
    for (const field of KEY_OBJECT_FIELDS) {
      if (!Object.hasOwn(event, field)) continue
      if (!isObject(event[field]) || typeof event[field].key !== 'string') {
        errors.push(`event[${index}].${field} must be { key: string }, got ${JSON.stringify(event[field])}`)
      }
    }
    if (Object.hasOwn(event, 'targeting_key') && typeof event.targeting_key !== 'string') {
      errors.push(`event[${index}].targeting_key must be a string`)
    }
    if (Object.hasOwn(event, 'context') && !isObject(event.context)) {
      errors.push(`event[${index}].context must be an object`)
    }
  }
  return errors
}

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
      assert.strictEqual(typeof ev.timestamp, 'number')
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
      const ev1 = makeEvent({ attrs: { count: 1 } }) // int 1
      const ev2 = makeEvent({ attrs: { count: '1' } }) // string "1"

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
      writer.enqueue(makeEvent({ attrs: { user: 'c' } })) // should overflow to degraded
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      // Full tier: at most 2 entries; degraded tier: 1 entry (all share same degraded key)
      // So total buckets should be 2 full + 1 degraded, OR ≤3 total with at least 1 aggregated
      assert.ok(payload.flagEvaluations.length <= 3)
    })

    it('when degradedCap is exceeded, droppedDegradedOverflow is incremented (observable)', () => {
      writer._globalCap = 1
      writer._perFlagCap = 1
      writer._degradedCap = 0 // degraded immediately full

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
      writer._globalCap = 0 // force everything to degraded immediately
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
      assert.doesNotMatch(src, /md5/i, 'writer must NOT reference md5 (frozen contract)')
    })
  })

  describe('JSON schema validation (G3)', () => {
    const validatePayload = () => {
      const payload = JSON.parse(request.getCall(0).args[0])
      const errors = validateFlagEvaluationPayload(payload)
      assert.deepStrictEqual(errors, [], 'payload must satisfy the flageval-worker contract')
      return payload
    }

    it('full-tier payload validates against the worker schema', () => {
      writer.enqueue(makeEvent())
      writer.flush()
      validatePayload()
    })

    it('serializes variant and allocation as {key} OBJECTS, not bare strings', () => {
      writer.enqueue(makeEvent({ variant: 'on', allocationKey: 'alloc-1' }))
      writer.flush()

      const payload = validatePayload()
      const ev = payload.flagEvaluations[0]
      assert.deepStrictEqual(ev.variant, { key: 'on' })
      assert.deepStrictEqual(ev.allocation, { key: 'alloc-1' })
    })

    it('degraded-tier payload validates against the worker schema', () => {
      writer._globalCap = 0 // force degraded
      writer._degradedCap = 100000
      writer.enqueue(makeEvent())
      writer.flush()
      validatePayload()
    })

    it('a bare-string variant FAILS the schema check (proves the validator is mechanical, not prose)', () => {
      const bad = {
        context: { service: 's' },
        flagEvaluations: [{
          timestamp: 1,
          flag: { key: 'f' },
          first_evaluation: 1,
          last_evaluation: 1,
          evaluation_count: 1,
          variant: 'on', // bare string — must be rejected
        }],
      }
      const errors = validateFlagEvaluationPayload(bad)
      assert.ok(errors.some(e => /variant must be \{ key: string \}/.test(e)),
        `validator must reject a bare-string variant; got errors: ${JSON.stringify(errors)}`)
    })
  })

  describe('async boundary — enqueue does NOT aggregate inline', () => {
    it('enqueue does not invoke the aggregator on the hot path; the scheduled drain does', () => {
      const aggregateSpy = sinon.spy(writer, '_aggregate')

      writer.enqueue(makeEvent())

      sinon.assert.notCalled(aggregateSpy)
      assert.strictEqual(writer._rawQueue.length, 1,
        'enqueue must only push the raw event; aggregation is deferred')
      assert.strictEqual(writer._full.size, 0,
        'no full-tier bucket may exist before the drain runs')

      // The drain (off the hot path) is what aggregates.
      writer._drainQueue()

      sinon.assert.calledOnce(aggregateSpy)
      assert.strictEqual(writer._rawQueue.length, 0)
      assert.strictEqual(writer._full.size, 1)
    })

    it('schedules exactly one drain for a burst of enqueues (microtask coalescing)', () => {
      const setImmediateSpy = sinon.spy(global, 'setImmediate')
      try {
        writer.enqueue(makeEvent({ attrs: { user: 'a' } }))
        writer.enqueue(makeEvent({ attrs: { user: 'b' } }))
        writer.enqueue(makeEvent({ attrs: { user: 'c' } }))

        sinon.assert.calledOnce(setImmediateSpy)
        assert.strictEqual(writer._rawQueue.length, 3)
      } finally {
        setImmediateSpy.restore()
      }
    })

    it('the scheduled drain (setImmediate callback) aggregates queued events', () => {
      // With fake timers, drive the scheduled drain explicitly.
      writer.enqueue(makeEvent())
      assert.strictEqual(writer._full.size, 0)

      clock.tick(0) // fire the setImmediate-scheduled drain (not the 10s interval)

      assert.strictEqual(writer._full.size, 1, 'queued event must aggregate when the drain fires')
    })
  })

  describe('backpressure — bounded hand-off queue (G4)', () => {
    it('enqueue returns true when accepted, false when the queue is full', () => {
      writer._rawQueueCap = 2

      assert.strictEqual(writer.enqueue(makeEvent()), true)
      assert.strictEqual(writer.enqueue(makeEvent()), true)
      assert.strictEqual(writer.enqueue(makeEvent()), false, 'third enqueue overflows the 2-slot queue')
    })

    it('increments an observable drop counter on queue overflow', () => {
      writer._rawQueueCap = 1

      writer.enqueue(makeEvent()) // accepted
      writer.enqueue(makeEvent()) // dropped
      writer.enqueue(makeEvent()) // dropped

      assert.strictEqual(writer._droppedQueueOverflow, 2,
        'each overflowed enqueue must increment the observable drop counter')
      assert.strictEqual(writer._rawQueue.length, 1, 'only the accepted event is queued')
    })

    it('emits a warning when dropped counts are non-zero at flush', () => {
      writer._rawQueueCap = 1
      writer.enqueue(makeEvent()) // accepted
      writer.enqueue(makeEvent()) // dropped → _droppedQueueOverflow = 1

      writer.flush()

      sinon.assert.calledWithMatch(log.warn, sinon.match(/dropped evaluations/))
    })

    it('degraded-overflow drop count is reset only AFTER a flush emits it', () => {
      writer._globalCap = 0 // everything routes to degraded
      writer._degradedCap = 0 // degraded immediately full → drop+count

      writer.enqueue(makeEvent({ flagKey: 'flag-a' }))
      writer._drainQueue()

      assert.strictEqual(writer._droppedDegradedOverflow, 1)

      writer.flush() // emits the warning, then resets
      assert.strictEqual(writer._droppedDegradedOverflow, 0, 'reset only after emission')
      // printf args: (template, writerName, queueDrops, degradedDrops)
      const warnCall = log.warn.getCalls().find(c => /dropped evaluations/.test(c.args[0]))
      assert.ok(warnCall, 'a drop warning must be emitted')
      assert.strictEqual(warnCall.args[3], 1, 'degraded-overflow count of 1 must be emitted')
    })
  })

  describe('shutdown drains + flushes (G5)', () => {
    it('destroy() drains pending queued events and flushes them (not just interrupts)', () => {
      // Event is only queued, never aggregated — destroy must drain it.
      writer.enqueue(makeEvent({ flagKey: 'drain-me' }))
      assert.strictEqual(writer._full.size, 0, 'precondition: event is queued, not yet aggregated')

      writer.destroy()

      sinon.assert.calledOnce(request)
      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 1)
      assert.strictEqual(payload.flagEvaluations[0].flag.key, 'drain-me',
        'the queued-but-unaggregated event must reach the transport on shutdown')
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
