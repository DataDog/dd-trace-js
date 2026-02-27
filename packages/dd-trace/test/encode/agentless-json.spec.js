'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const id = require('../../src/id')
const { AgentlessJSONEncoder } = require('../../src/encode/agentless-json')

describe('AgentlessJSONEncoder', () => {
  let encoder
  let data

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
  })

  describe('encode', () => {
    it('should encode spans to JSON format', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.ok(decoded.spans)
      assert.ok(Array.isArray(decoded.spans))
      assert.strictEqual(decoded.spans.length, 1)
    })

    it('should encode IDs as lowercase hex strings', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.spans[0]

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
      const span = decoded.spans[0]

      // Should be full 32-character hex string
      assert.strictEqual(span.trace_id, '0123456789abcdef0123456789abcdef')
      assert.strictEqual(span.trace_id.length, 32)
    })

    it('should include span fields with start time converted to seconds', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.spans[0]

      assert.strictEqual(span.name, 'test')
      assert.strictEqual(span.resource, 'test-resource')
      assert.strictEqual(span.service, 'test-service')
      assert.strictEqual(span.type, 'web')
      assert.strictEqual(span.error, 0)
      // Start time is converted from nanoseconds to seconds for intake format
      assert.strictEqual(span.start, 1234567890)
      assert.strictEqual(span.duration, 5000000)
      assert.deepStrictEqual(span.meta, { foo: 'bar' })
      assert.deepStrictEqual(span.metrics, { example: 1.5 })
    })

    it('should handle multiple spans in one trace', () => {
      encoder.encode(data)
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.spans.length, 2)
    })

    it('should handle spans without optional fields', () => {
      delete data[0].type
      delete data[0].meta_struct
      delete data[0].links

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.spans[0]

      assert.strictEqual(span.type, undefined)
      assert.strictEqual(span.meta_struct, undefined)
      assert.strictEqual(span.links, undefined)
    })

    it('should convert span_events to meta.events JSON string', () => {
      data[0].span_events = [{ name: 'exception', attributes: { message: 'error' } }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.spans[0]

      assert.strictEqual(span.span_events, undefined)
      assert.strictEqual(typeof span.meta.events, 'string')
      assert.deepStrictEqual(JSON.parse(span.meta.events), [{ name: 'exception', attributes: { message: 'error' } }])
    })

    it('should include meta_struct when present', () => {
      data[0].meta_struct = { nested: { key: 'value' } }

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.spans[0].meta_struct, { nested: { key: 'value' } })
    })

    it('should include links when non-empty', () => {
      data[0].links = [{ trace_id: 'abc123', span_id: 'def456' }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.spans[0].links, [{ trace_id: 'abc123', span_id: 'def456' }])
    })

    it('should skip malformed spans and continue encoding', () => {
      const goodSpan = data[0]
      const badSpan = { name: 'bad' } // Missing required ID fields

      encoder.encode([goodSpan, badSpan])

      // Should have encoded only the good span
      assert.strictEqual(encoder.count(), 1)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      assert.strictEqual(decoded.spans.length, 1)
      assert.strictEqual(decoded.spans[0].name, 'test')
    })
  })

  describe('count', () => {
    it('should report its count', () => {
      assert.strictEqual(encoder.count(), 0)

      encoder.encode(data)

      assert.strictEqual(encoder.count(), 1)

      encoder.encode(data)

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

    it('should return empty buffer when no spans encoded', () => {
      const buffer = encoder.makePayload()

      assert.ok(Buffer.isBuffer(buffer))
      assert.strictEqual(buffer.length, 0)
    })

    it('should return empty buffer and reset on JSON stringify failure', () => {
      encoder.encode(data)

      // Inject a circular reference to cause JSON.stringify to fail
      const circular = {}
      circular.self = circular
      encoder._spans[0].meta = circular

      const buffer = encoder.makePayload()

      assert.strictEqual(buffer.length, 0)
      assert.strictEqual(encoder.count(), 0)
    })
  })
})
