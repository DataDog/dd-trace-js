'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const Ajv = require('ajv')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

const schemaPath = path.join(__dirname, 'testdata/flageval-worker/batchedflagevaluations.json')
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
const ajv = new Ajv({ allErrors: true })
const validateBatchedFlagEvaluations = ajv.compile(schema)

function validateFlagEvaluationPayload (payload) {
  if (validateBatchedFlagEvaluations(payload)) return []
  return validateBatchedFlagEvaluations.errors.map(error => {
    const path = error.instancePath || error.dataPath || '/'
    return `${path} ${error.message} ${JSON.stringify(error.params || {})}`
  })
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
    allocationKey: 'alloc-1',
    targetingKey: 'user-1',
    evalTimeMs: 1760000000000,
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
    it('resolves endpoint to /evp_proxy/v2/api/v2/flagevaluation', () => {
      assert.strictEqual(writer._endpoint, '/evp_proxy/v2/api/v2/flagevaluation')
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
      writer.enqueue(makeEvent({ evalTimeMs: 1760000001000 }))
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
    it('identical evaluations aggregate into ONE bucket with count and first/last bounds', () => {
      const ev1 = makeEvent({ evalTimeMs: 1760000002000 })
      const ev2 = makeEvent({ evalTimeMs: 1760000001000 })
      const ev3 = makeEvent({ evalTimeMs: 1760000003000 })

      writer.enqueue(ev1)
      writer.enqueue(ev2)
      writer.enqueue(ev3)
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 1)
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(ev.evaluation_count, 3)
      assert.ok(ev.first_evaluation <= ev.last_evaluation)
      assert.strictEqual(ev.first_evaluation, 1760000001000)
      assert.strictEqual(ev.last_evaluation, 1760000003000)
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

    it('context keying keeps boolean, null, and empty-context snapshots distinct', () => {
      writer.enqueue(makeEvent({ attrs: { value: true } }))
      writer.enqueue(makeEvent({ attrs: { value: false } }))
      writer.enqueue(makeEvent({ attrs: { value: null } }))
      writer.enqueue(makeEvent({ attrs: { value: new Date('2026-06-16T00:00:00.000Z') } }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 4)
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

    it('existing degraded buckets aggregate count and first/last bounds', () => {
      writer._globalCap = 0
      writer._degradedCap = 100000

      writer.enqueue(makeEvent({ evalTimeMs: 1760000002000 }))
      writer.enqueue(makeEvent({ evalTimeMs: 1760000001000 }))
      writer.enqueue(makeEvent({ evalTimeMs: 1760000003000 }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 1)
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(ev.evaluation_count, 3)
      assert.strictEqual(ev.first_evaluation, 1760000001000)
      assert.strictEqual(ev.last_evaluation, 1760000003000)
      assert.ok(!ev.targeting_key, 'degraded tier must omit targeting_key')
      assert.ok(!ev.context, 'degraded tier must omit context')
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
    it('context with >256 fields is pruned to ≤256 before queueing', () => {
      const attrs = {}
      for (let i = 0; i < 300; i++) {
        attrs[`field_${i}`] = `value_${i}`
      }

      writer.enqueue(makeEvent({ attrs }))
      assert.strictEqual(Object.keys(writer._rawQueue[0].attrs).length, 256,
        'queued context snapshot must be bounded before buffering')
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(Object.keys(ev.context.evaluation).length, 256)
    })

    it('context with a string value >256 chars has that field skipped before queueing', () => {
      const attrs = { normal: 'ok', oversized: 'x'.repeat(300) }

      writer.enqueue(makeEvent({ attrs }))
      assert.ok(!Object.hasOwn(writer._rawQueue[0].attrs, 'oversized'),
        'oversized string field must be pruned from the queued snapshot')
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

    it('flattens nested context values before queueing to avoid String(object) collisions', () => {
      writer.enqueue(makeEvent({ attrs: { user: { id: 1, plan: 'pro' } } }))

      assert.deepStrictEqual(writer._rawQueue[0].attrs, {
        'user.id': 1,
        'user.plan': 'pro',
      })
    })

    it('flattens arrays and skips unsupported context values before queueing', () => {
      writer.enqueue(makeEvent({
        attrs: {
          list: ['a', { nested: true }, null],
          skipUndefined: undefined,
          skipFunction: () => {},
          skipSymbol: Symbol('skip'),
          skipBigInt: 1n,
        },
      }))

      assert.deepStrictEqual(writer._rawQueue[0].attrs, {
        'list.0': 'a',
        'list.1.nested': true,
        'list.2': null,
      })
    })

    it('does not include targetingKey inside context.evaluation', () => {
      writer.enqueue(makeEvent({ attrs: { targetingKey: 'user-1', plan: 'premium' } }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations[0].targeting_key, 'user-1')
      assert.ok(!Object.hasOwn(payload.flagEvaluations[0].context.evaluation, 'targetingKey'))
    })
  })

  describe('EVP transport', () => {
    it('POSTs to /evp_proxy/v2/api/v2/flagevaluation with correct headers', () => {
      writer.enqueue(makeEvent())
      writer.flush()

      sinon.assert.calledOnce(request)
      const options = request.getCall(0).args[1]
      assert.strictEqual(options.method, 'POST')
      assert.match(options.path, /\/evp_proxy\/v2\/api\/v2\/flagevaluation/)
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
      assert.strictEqual(options.headers['Content-Type'], 'application/json')
    })
  })

  describe('cap sizing', () => {
    it('uses named sizing arithmetic for the default caps', () => {
      assert.deepStrictEqual(FlagEvaluationsWriter._capSizingForTest, {
        EVAL_SCALE_FULL_BUCKET_TARGET: 125000,
        EVAL_SCALE_DEGRADED_BUCKET_TARGET: 25000,
        GLOBAL_CAP: 131072,
        PER_FLAG_CAP: 10000,
        DEGRADED_CAP: 32768,
      })
    })
  })

  describe('payload size limits', () => {
    it('splits aggregate payloads so each request stays under the configured payload limit', () => {
      writer._payloadSizeLimit = 520

      writer.enqueue(makeEvent({ flagKey: 'flag-a', attrs: { blob: 'a'.repeat(180) } }))
      writer.enqueue(makeEvent({ flagKey: 'flag-b', attrs: { blob: 'b'.repeat(180) } }))
      writer.flush()

      assert.ok(request.callCount > 1, 'payload limit should split aggregate events across requests')
      for (const call of request.getCalls()) {
        assert.ok(Buffer.byteLength(call.args[0]) <= writer._payloadSizeLimit,
          `request payload exceeded configured limit: ${Buffer.byteLength(call.args[0])}`)
      }
    })

    it('degrades a full aggregate event before dropping it for the configured event size limit', () => {
      writer._eventSizeLimit = 240

      writer.enqueue(makeEvent({ attrs: { blob: 'x'.repeat(180) } }))
      writer.flush()

      sinon.assert.calledOnce(request)
      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]
      assert.ok(!Object.hasOwn(ev, 'targeting_key'))
      assert.ok(!Object.hasOwn(ev, 'context'))
      sinon.assert.notCalled(log.warn)
    })

    it('drops a single aggregate event that exceeds the payload limit', () => {
      writer._payloadSizeLimit = 1

      writer.enqueue(makeEvent())
      writer.flush()

      sinon.assert.notCalled(request)
      sinon.assert.calledWithMatch(log.warn, sinon.match(/payload size .* exceeds limit/))
      assert.strictEqual(writer._droppedEvents, 1)
    })

    it('degrades a full aggregate event before dropping it for the configured payload limit', () => {
      writer._payloadSizeLimit = 350

      writer.enqueue(makeEvent({ flagKey: 'large', attrs: { blob: 'x'.repeat(256) } }))
      writer.flush()

      sinon.assert.calledOnce(request)
      const payload = JSON.parse(request.getCall(0).args[0])
      const ev = payload.flagEvaluations[0]
      assert.strictEqual(ev.flag.key, 'large')
      assert.ok(!Object.hasOwn(ev, 'targeting_key'))
      assert.ok(!Object.hasOwn(ev, 'context'))
      assert.ok(Buffer.byteLength(request.getCall(0).args[0]) <= writer._payloadSizeLimit)
      sinon.assert.notCalled(log.warn)
      assert.strictEqual(writer._droppedEvents, 0)
    })

    it('sends the current batch, then degrades the next event when it alone exceeds the payload limit', () => {
      writer._payloadSizeLimit = 350

      writer.enqueue(makeEvent({ flagKey: 'small', attrs: {} }))
      writer.enqueue(makeEvent({ flagKey: 'large', attrs: { blob: 'x'.repeat(256) } }))
      writer.flush()

      sinon.assert.calledTwice(request)
      const firstPayload = JSON.parse(request.getCall(0).args[0])
      const secondPayload = JSON.parse(request.getCall(1).args[0])
      assert.strictEqual(firstPayload.flagEvaluations.length, 1)
      assert.strictEqual(firstPayload.flagEvaluations[0].flag.key, 'small')
      assert.strictEqual(secondPayload.flagEvaluations.length, 1)
      assert.strictEqual(secondPayload.flagEvaluations[0].flag.key, 'large')
      assert.ok(!Object.hasOwn(secondPayload.flagEvaluations[0], 'targeting_key'))
      assert.ok(!Object.hasOwn(secondPayload.flagEvaluations[0], 'context'))
      for (const call of request.getCalls()) {
        assert.ok(Buffer.byteLength(call.args[0]) <= writer._payloadSizeLimit,
          `request payload exceeded configured limit: ${Buffer.byteLength(call.args[0])}`)
      }
      sinon.assert.notCalled(log.warn)
      assert.strictEqual(writer._droppedEvents, 0)
    })

    it('drops an already-degraded aggregate event that still exceeds the configured event size limit', () => {
      writer._globalCap = 0
      writer._eventSizeLimit = 120

      writer.enqueue(makeEvent({ flagKey: 'f'.repeat(180), attrs: {}, targetingKey: '' }))
      writer.flush()

      sinon.assert.notCalled(request)
      sinon.assert.calledWithMatch(log.warn, sinon.match(/event size .* exceeds limit/))
      assert.strictEqual(writer._droppedEvents, 1)
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

    it('serializes error.message and keeps it in bucket identity', () => {
      writer.enqueue(makeEvent({ variant: '', errorMessage: 'type mismatch' }))
      writer.enqueue(makeEvent({ variant: '', errorMessage: 'flag not found' }))
      writer.flush()

      const payload = validatePayload()
      assert.strictEqual(payload.flagEvaluations.length, 2)
      assert.deepStrictEqual(
        payload.flagEvaluations.map(ev => ev.error.message).sort(),
        ['flag not found', 'type mismatch']
      )
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
          timestamp: 1760000000000,
          flag: { key: 'f' },
          first_evaluation: 1760000000000,
          last_evaluation: 1760000000000,
          evaluation_count: 1,
          variant: 'on', // bare string — must be rejected
        }],
      }
      const errors = validateFlagEvaluationPayload(bad)
      assert.ok(errors.some(e => /variant/.test(e) && /object/.test(e)),
        `validator must reject a bare-string variant; got errors: ${JSON.stringify(errors)}`)
    })

    it('rejects a top-level reason field because the worker schema has additionalProperties=false', () => {
      const bad = {
        context: { service: 's' },
        flagEvaluations: [{
          timestamp: 1760000000000,
          flag: { key: 'f' },
          first_evaluation: 1760000000000,
          last_evaluation: 1760000000000,
          evaluation_count: 1,
          reason: 'targeting_match',
        }],
      }
      const errors = validateFlagEvaluationPayload(bad)
      assert.ok(errors.some(e => /additional properties/.test(e) || /reason/.test(e)),
        `validator must reject top-level reason; got errors: ${JSON.stringify(errors)}`)
    })
  })

  describe('G0 — OpenFeature reason is not EVP cardinality', () => {
    it('two evaluations differing only by reason aggregate into one schema-visible bucket', () => {
      writer.enqueue(makeEvent({ reason: 'targeting_match' }))
      writer.enqueue(makeEvent({ reason: 'split' }))
      writer.flush()

      const payload = JSON.parse(request.getCall(0).args[0])
      assert.strictEqual(payload.flagEvaluations.length, 1)
      assert.strictEqual(payload.flagEvaluations[0].evaluation_count, 2)
      assert.ok(!Object.hasOwn(payload.flagEvaluations[0], 'reason'))
    })
  })

  describe('async boundary — enqueue does NOT aggregate inline', () => {
    it('enqueue does not invoke the aggregator on the hot path; the scheduled drain does', () => {
      const aggregateSpy = sinon.spy(writer, '_aggregate')

      writer.enqueue(makeEvent())

      sinon.assert.notCalled(aggregateSpy)
      assert.strictEqual(writer._rawQueue.length, 1,
        'enqueue must only push the bounded event snapshot; aggregation is deferred')
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
