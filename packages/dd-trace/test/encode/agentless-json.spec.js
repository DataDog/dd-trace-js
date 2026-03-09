'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const id = require('../../src/id')
const { AgentlessJSONEncoder } = require('../../src/encode/agentless-json')

describe('AgentlessJSONEncoder', () => {
  let encoder
  let data
  let childSpan

  beforeEach(() => {
    encoder = new AgentlessJSONEncoder()
    data = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('5678efab5678efab'),
      parent_id: id('0000000000000000'),
      name: 'test',
      resource: 'test-resource',
      service: 'test-service',
      type: 'web',
      error: 0,
      meta: {
        foo: 'bar',
      },
      metrics: {
        example: 1.5,
      },
      start: 1234567890000000000,
      duration: 5000000,
      links: [],
    }]
    childSpan = {
      trace_id: id('1234abcd1234abcd'),
      span_id: id('aaaa000000000001'),
      parent_id: id('5678efab5678efab'),
      name: 'child',
      resource: 'child-resource',
      service: 'test-service',
      error: 0,
      meta: {},
      metrics: {},
      start: 1234567891000000000,
      duration: 1000000,
      links: [],
    }
  })

  describe('encode', () => {
    it('should encode a trace in the multi-trace JSON format', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.ok(decoded.traces)
      assert.ok(Array.isArray(decoded.traces))
      assert.strictEqual(decoded.traces.length, 1)
      assert.ok(Array.isArray(decoded.traces[0]))
      assert.strictEqual(decoded.traces[0].length, 1)
    })

    it('should encode IDs as lowercase hex strings', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0][0]

      assert.strictEqual(span.trace_id, '1234abcd1234abcd')
      assert.strictEqual(span.span_id, '5678efab5678efab')
      assert.strictEqual(span.parent_id, '0000000000000000')
    })

    it('should encode 128-bit trace IDs correctly', () => {
      // 128-bit trace IDs are used in W3C Trace Context
      data[0].trace_id = id('0123456789abcdef0123456789abcdef')

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0][0]

      // Should be full 32-character hex string
      assert.strictEqual(span.trace_id, '0123456789abcdef0123456789abcdef')
      assert.strictEqual(span.trace_id.length, 32)
    })

    it('should include span fields with start time converted to seconds', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0][0]

      assert.strictEqual(span.name, 'test')
      assert.strictEqual(span.resource, 'test-resource')
      assert.strictEqual(span.service, 'test-service')
      assert.strictEqual(span.type, 'web')
      assert.strictEqual(span.error, 0)
      // Start time is converted from nanoseconds to seconds for intake format
      assert.strictEqual(span.start, 1234567890)
      assert.strictEqual(span.duration, 5000000)
      assert.deepStrictEqual(span.meta, { foo: 'bar', '_dd.compute_stats': '1' })
      assert.deepStrictEqual(span.metrics, { example: 1.5, _trace_root: 1 })
    })

    it('should handle multiple spans in one trace', () => {
      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces.length, 1)
      assert.strictEqual(decoded.traces[0].length, 2)
      assert.strictEqual(decoded.traces[0][0].meta['_dd.compute_stats'], '1')
      assert.strictEqual(decoded.traces[0][1].meta['_dd.compute_stats'], undefined)
    })

    it('should batch multiple traces into a single payload', () => {
      const trace1 = [data[0]]
      const trace2 = [childSpan]

      encoder.encode(trace1)
      encoder.encode(trace2)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces.length, 2)
      assert.strictEqual(decoded.traces[0].length, 1)
      assert.strictEqual(decoded.traces[1].length, 1)
      assert.strictEqual(decoded.traces[0][0].name, 'test')
      assert.strictEqual(decoded.traces[1][0].name, 'child')
    })

    it('should set _dd.compute_stats on the first span of each trace', () => {
      encoder.encode([data[0]])
      encoder.encode([childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0][0].meta['_dd.compute_stats'], '1')
      assert.strictEqual(decoded.traces[1][0].meta['_dd.compute_stats'], '1')
    })

    it('should handle spans without optional fields', () => {
      delete data[0].type
      delete data[0].meta_struct
      delete data[0].links

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0][0]

      assert.strictEqual(span.type, undefined)
      assert.strictEqual(span.meta_struct, undefined)
      assert.strictEqual(span.links, undefined)
    })

    it('should convert span_events to meta.events JSON string', () => {
      data[0].span_events = [{ name: 'exception', attributes: { message: 'error' } }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0][0]

      assert.strictEqual(span.span_events, undefined)
      assert.strictEqual(typeof span.meta.events, 'string')
      assert.deepStrictEqual(JSON.parse(span.meta.events), [{ name: 'exception', attributes: { message: 'error' } }])
    })

    it('should include meta_struct when present', () => {
      data[0].meta_struct = { nested: { key: 'value' } }

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.traces[0][0].meta_struct, { nested: { key: 'value' } })
    })

    it('should include links when non-empty', () => {
      data[0].links = [{ trace_id: 'abc123', span_id: 'def456' }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.traces[0][0].links, [{ trace_id: 'abc123', span_id: 'def456' }])
    })

    it('should set _trace_root on spans with zero parent_id', () => {
      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0][0].metrics._trace_root, 1)
      assert.strictEqual(decoded.traces[0][1].metrics._trace_root, undefined)
    })

    it('should set _top_level on spans marked as top-level', () => {
      data[0].metrics['_dd.top_level'] = 1

      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0][0].metrics._top_level, 1)
      assert.strictEqual(decoded.traces[0][1].metrics._top_level, undefined)
    })

    it('should not set _top_level when _dd.top_level is 0', () => {
      data[0].metrics['_dd.top_level'] = 0

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0][0].metrics._top_level, undefined)
    })

    it('should not add a trace entry for an empty span array', () => {
      encoder.encode([])

      assert.strictEqual(encoder.count(), 0)
      const buffer = encoder.makePayload()
      assert.strictEqual(buffer.length, 0)
    })

    it('should skip traces where all spans are malformed', () => {
      const badSpan = { name: 'bad' }

      encoder.encode([badSpan])

      assert.strictEqual(encoder.count(), 0)
      const buffer = encoder.makePayload()
      assert.strictEqual(buffer.length, 0)
    })

    it('should skip malformed spans within a trace and keep valid ones', () => {
      const goodSpan = data[0]
      const badSpan = { name: 'bad' } // Missing required ID fields

      encoder.encode([goodSpan, badSpan])

      assert.strictEqual(encoder.count(), 1)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      assert.strictEqual(decoded.traces[0].length, 1)
      assert.strictEqual(decoded.traces[0][0].name, 'test')
    })

    it('should set _dd.compute_stats on next span when first span is malformed', () => {
      const badSpan = { name: 'bad' }

      encoder.encode([badSpan, childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].length, 1)
      assert.strictEqual(decoded.traces[0][0].meta['_dd.compute_stats'], '1')
    })
  })

  describe('isFull', () => {
    it('should return false when under the size limit', () => {
      encoder.encode(data)

      assert.strictEqual(encoder.isFull(), false)
    })

    it('should return true when over the 15MB size limit', () => {
      // Meta values are truncated to 25KB, so use many keys per span
      // and many traces to exceed 15MB
      const meta = {}
      for (let k = 0; k < 50; k++) {
        meta[`key${k}`] = 'x'.repeat(25000)
      }
      // Each trace ≈ 50 * 25KB ≈ 1.2MB, so 13 traces should exceed 15MB
      for (let i = 0; i < 13; i++) {
        const span = {
          trace_id: id('1234abcd1234abcd'),
          span_id: id('5678efab5678efab'),
          parent_id: id('0000000000000000'),
          name: 'test',
          resource: 'test-resource',
          service: 'test-service',
          error: 0,
          meta: { ...meta },
          metrics: {},
          start: 1234567890000000000,
          duration: 5000000,
          links: [],
        }
        encoder.encode([span])
      }

      assert.strictEqual(encoder.isFull(), true)
    })

    it('should reset isFull after makePayload', () => {
      const meta = {}
      for (let k = 0; k < 50; k++) {
        meta[`key${k}`] = 'x'.repeat(25000)
      }
      for (let i = 0; i < 13; i++) {
        const span = {
          trace_id: id('1234abcd1234abcd'),
          span_id: id('5678efab5678efab'),
          parent_id: id('0000000000000000'),
          name: 'test',
          resource: 'test-resource',
          service: 'test-service',
          error: 0,
          meta: { ...meta },
          metrics: {},
          start: 1234567890000000000,
          duration: 5000000,
          links: [],
        }
        encoder.encode([span])
      }

      assert.strictEqual(encoder.isFull(), true)

      encoder.makePayload()

      assert.strictEqual(encoder.isFull(), false)
    })
  })

  describe('count', () => {
    it('should report its trace count', () => {
      assert.strictEqual(encoder.count(), 0)

      encoder.encode(data)

      assert.strictEqual(encoder.count(), 1)

      encoder.encode([childSpan])

      assert.strictEqual(encoder.count(), 2)
    })
  })

  describe('reset', () => {
    it('should reset the encoder state', () => {
      encoder.encode(data)
      assert.strictEqual(encoder.count(), 1)

      encoder.reset()

      assert.strictEqual(encoder.count(), 0)
    })
  })

  describe('makePayload', () => {
    it('should return a Buffer', () => {
      encoder.encode(data)
      const buffer = encoder.makePayload()

      assert.ok(Buffer.isBuffer(buffer))
    })

    it('should reset after making payload', () => {
      encoder.encode(data)
      encoder.makePayload()

      assert.strictEqual(encoder.count(), 0)
    })

    it('should return empty buffer when no traces encoded', () => {
      const buffer = encoder.makePayload()

      assert.ok(Buffer.isBuffer(buffer))
      assert.strictEqual(buffer.length, 0)
    })

    it('should return empty buffer and reset on JSON stringify failure', () => {
      encoder.encode(data)

      // Inject a circular reference to cause JSON.stringify to fail
      const circular = {}
      circular.self = circular
      encoder._traces[0][0].meta = circular

      const buffer = encoder.makePayload()

      assert.strictEqual(buffer.length, 0)
      assert.strictEqual(encoder.count(), 0)
    })
  })
})
