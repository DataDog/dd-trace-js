'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, IGNORE_OTEL_ERROR } = require('../../src/constants')
const {
  addOtelEvent,
  addOtelLink,
  addOtelLinks,
  applyOtelStatus,
  normalizeLinkContext,
  recordException,
  setOtelAttribute,
  setOtelAttributes,
} = require('../../src/opentelemetry/span-helpers')

/**
 * Lightweight DatadogSpan-shaped fixture. Just enough to exercise each helper's
 * contract; no DD-tracer wiring or scope-manager interaction.
 */
function createMockDdSpan ({ ended = false } = {}) {
  const tags = {}
  const events = []
  const links = []
  let operationName

  return {
    // Match the DD span shape: `_duration` is undefined while recording, a number once
    // finished. The helpers' `isWritable` gate reads this directly.
    _duration: ended ? 100 : undefined,
    setTag (key, value) { tags[key] = value },
    // `IGNORE_OTEL_ERROR` is a Symbol key; use ownKeys so Symbol entries are not skipped.
    addTags (kv) {
      for (const key of Reflect.ownKeys(kv)) tags[key] = kv[key]
    },
    addLink (link) { links.push(link) },
    addEvent (name, attributes, startTime) {
      events.push({ name, attributes, startTime })
    },
    setOperationName (name) { operationName = name },
    context () { return { _tags: tags } },

    // Read-only inspection handles for assertions.
    get tags () { return tags },
    get events () { return events },
    get links () { return links },
    get operationName () { return operationName },
  }
}

describe('OTel bridge helpers', () => {
  describe('writable-span gate', () => {
    it('writes when the underlying span is recording', () => {
      const ddSpan = createMockDdSpan()
      setOtelAttribute(ddSpan, 'foo', 'bar')

      assert.strictEqual(ddSpan.tags.foo, 'bar')
    })

    it('skips every helper when the underlying span has finished', () => {
      const ddSpan = createMockDdSpan({ ended: true })

      setOtelAttribute(ddSpan, 'foo', 'bar')
      setOtelAttributes(ddSpan, { baz: 'buz' })
      addOtelLink(ddSpan, {
        context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 },
      })
      addOtelLinks(ddSpan, [
        { context: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) } },
      ])
      addOtelEvent(ddSpan, 'evt', { code: 42 })
      recordException(ddSpan, new Error('boom'))

      assert.deepStrictEqual(ddSpan.tags, {})
      assert.strictEqual(ddSpan.links.length, 0)
      assert.strictEqual(ddSpan.events.length, 0)
    })
  })

  describe('setOtelAttribute', () => {
    it('mirrors http.response.status_code onto the special http.status_code DD tag', () => {
      const ddSpan = createMockDdSpan()
      setOtelAttribute(ddSpan, 'http.response.status_code', 200)

      assert.deepStrictEqual(ddSpan.tags, {
        'http.response.status_code': 200,
        'http.status_code': '200',
      })
    })

    it('writes a single tag for non-status keys', () => {
      const ddSpan = createMockDdSpan()
      setOtelAttribute(ddSpan, 'service.name', 'svc')

      assert.deepStrictEqual(ddSpan.tags, { 'service.name': 'svc' })
    })
  })

  describe('setOtelAttributes', () => {
    it('applies all attributes and mirrors http.response.status_code', () => {
      const ddSpan = createMockDdSpan()
      setOtelAttributes(ddSpan, { 'http.response.status_code': 404, foo: 'bar' })

      assert.deepStrictEqual(ddSpan.tags, {
        'http.response.status_code': 404,
        'http.status_code': '404',
        foo: 'bar',
      })
    })
  })

  describe('addOtelLink', () => {
    it('accepts the {context, attributes} form', () => {
      const ddSpan = createMockDdSpan()
      addOtelLink(ddSpan, {
        context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 },
        attributes: { foo: 'bar' },
      })

      assert.strictEqual(ddSpan.links.length, 1)
      assert.deepStrictEqual(ddSpan.links[0].attributes, { foo: 'bar' })
    })

    it('accepts the deprecated (context, attrs) form', () => {
      const ddSpan = createMockDdSpan()
      addOtelLink(
        ddSpan,
        { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
        { foo: 'bar' }
      )

      assert.strictEqual(ddSpan.links.length, 1)
      assert.deepStrictEqual(ddSpan.links[0].attributes, { foo: 'bar' })
    })

    it('skips when no link is provided', () => {
      const ddSpan = createMockDdSpan()
      addOtelLink(ddSpan, undefined)
      addOtelLink(ddSpan, null)

      assert.strictEqual(ddSpan.links.length, 0)
    })

    it('skips when the context cannot be normalized', () => {
      const ddSpan = createMockDdSpan()
      addOtelLink(ddSpan, { context: { traceId: 1, spanId: 2 } })

      assert.strictEqual(ddSpan.links.length, 0)
    })
  })

  describe('addOtelLinks', () => {
    it('forwards each link in the array', () => {
      const ddSpan = createMockDdSpan()
      addOtelLinks(ddSpan, [
        { context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) } },
        { context: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) } },
      ])

      assert.strictEqual(ddSpan.links.length, 2)
    })

    it('silently ignores non-array input', () => {
      const ddSpan = createMockDdSpan()
      addOtelLinks(ddSpan, undefined)
      addOtelLinks(ddSpan, 'not an array')
      addOtelLinks(ddSpan, null)

      assert.strictEqual(ddSpan.links.length, 0)
    })
  })

  describe('addOtelEvent', () => {
    const hrTime = /** @type {[number, number]} */ ([1700000000, 500000000])
    const hrTimeMs = hrTime[0] * 1e3 + hrTime[1] / 1e6

    it('treats hrTime as the second argument when no attributes are passed', () => {
      const ddSpan = createMockDdSpan()
      addOtelEvent(ddSpan, 'evt', hrTime)

      assert.deepStrictEqual(ddSpan.events, [
        { name: 'evt', attributes: undefined, startTime: hrTimeMs },
      ])
    })

    it('treats Date as the second argument', () => {
      const ddSpan = createMockDdSpan()
      const date = new Date(1700000000000)
      addOtelEvent(ddSpan, 'evt', date)

      assert.strictEqual(ddSpan.events[0].startTime, date.getTime())
    })

    it('attaches attributes when the second argument is an attributes object', () => {
      const ddSpan = createMockDdSpan()
      addOtelEvent(ddSpan, 'evt', { code: 42 }, hrTime)

      assert.deepStrictEqual(ddSpan.events, [
        { name: 'evt', attributes: { code: 42 }, startTime: hrTimeMs },
      ])
    })
  })

  describe('recordException', () => {
    it('writes error tags and an exception event', () => {
      const ddSpan = createMockDdSpan()
      const error = new Error('boom')
      // Date.now() is past `timeOrigin`; the vendored `timeInputToHrTime` treats numbers
      // smaller than that as performance-relative timestamps and adds the origin.
      const now = Date.now()
      recordException(ddSpan, error, now)

      assert.strictEqual(ddSpan.tags[ERROR_TYPE], 'Error')
      assert.strictEqual(ddSpan.tags[ERROR_MESSAGE], 'boom')
      assert.strictEqual(ddSpan.tags[ERROR_STACK], error.stack)
      assert.strictEqual(ddSpan.tags[IGNORE_OTEL_ERROR], true)
      assert.deepStrictEqual(ddSpan.events, [{
        name: 'Error',
        attributes: {
          'exception.message': 'boom',
          'exception.stacktrace': error.stack,
        },
        startTime: now,
      }])
    })

    it('preserves an existing IGNORE_OTEL_ERROR=false tag from setStatus(ERROR)', () => {
      const ddSpan = createMockDdSpan()
      ddSpan.tags[IGNORE_OTEL_ERROR] = false
      recordException(ddSpan, new Error('boom'))

      assert.strictEqual(ddSpan.tags[IGNORE_OTEL_ERROR], false)
    })
  })

  describe('applyOtelStatus precedence', () => {
    it('ignores UNSET and missing codes, returning currentCode unchanged', () => {
      const ddSpan = createMockDdSpan()

      assert.strictEqual(applyOtelStatus(ddSpan, 0, { code: 0 }), 0)
      assert.strictEqual(applyOtelStatus(ddSpan, 0, undefined), 0)
      assert.strictEqual(applyOtelStatus(ddSpan, 2, { code: 0 }), 2)
      assert.deepStrictEqual(ddSpan.tags, {})
    })

    it('locks at OK once set', () => {
      const ddSpan = createMockDdSpan()
      const fromUnset = applyOtelStatus(ddSpan, 0, { code: 1 })
      assert.strictEqual(fromUnset, 1)

      const stillOk = applyOtelStatus(ddSpan, 1, { code: 2, message: 'late error' })
      assert.strictEqual(stillOk, 1)
      assert.deepStrictEqual(ddSpan.tags, {})
    })

    it('writes ERROR tags on transition to ERROR', () => {
      const ddSpan = createMockDdSpan()
      const after = applyOtelStatus(ddSpan, 0, { code: 2, message: 'boom' })

      assert.strictEqual(after, 2)
      assert.strictEqual(ddSpan.tags[ERROR_MESSAGE], 'boom')
      assert.strictEqual(ddSpan.tags[IGNORE_OTEL_ERROR], false)
    })

    it('lets ERROR replace ERROR with a fresh message', () => {
      const ddSpan = createMockDdSpan()
      applyOtelStatus(ddSpan, 0, { code: 2, message: 'first' })
      const after = applyOtelStatus(ddSpan, 2, { code: 2, message: 'second' })

      assert.strictEqual(after, 2)
      assert.strictEqual(ddSpan.tags[ERROR_MESSAGE], 'second')
    })

    it('records the OK transition out of ERROR so future ERRORs are locked', () => {
      const ddSpan = createMockDdSpan()
      applyOtelStatus(ddSpan, 0, { code: 2, message: 'first' })
      const afterOk = applyOtelStatus(ddSpan, 2, { code: 1 })
      assert.strictEqual(afterOk, 1)

      const stillOk = applyOtelStatus(ddSpan, 1, { code: 2, message: 'should be ignored' })
      assert.strictEqual(stillOk, 1)
      // The first ERROR's message stays. Tag clearing on OK override is out of scope.
      assert.strictEqual(ddSpan.tags[ERROR_MESSAGE], 'first')
    })
  })

  describe('normalizeLinkContext', () => {
    it('returns the bridge wrapper\'s _ddContext when present', () => {
      const ddContext = { marker: 'inner' }
      assert.strictEqual(normalizeLinkContext({ _ddContext: ddContext }), ddContext)
    })

    it('returns a DatadogSpanContext-shaped input as-is', () => {
      const fake = { toTraceId () { return 't' }, toSpanId () { return 's' } }
      assert.strictEqual(normalizeLinkContext(fake), fake)
    })

    it('builds a DatadogSpanContext from a standard OTel SpanContext shape', () => {
      const result = normalizeLinkContext({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: 1,
      })

      assert.ok(result, 'expected a DatadogSpanContext')
      assert.strictEqual(typeof result.toTraceId, 'function')
    })

    it('returns undefined for missing or invalid context', () => {
      assert.strictEqual(normalizeLinkContext(undefined), undefined)
      assert.strictEqual(normalizeLinkContext(null), undefined)
      assert.strictEqual(normalizeLinkContext({ traceId: 1, spanId: 2 }), undefined)
    })
  })
})
