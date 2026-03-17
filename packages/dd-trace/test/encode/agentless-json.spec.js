'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const id = require('../../src/id')
const { AgentlessJSONEncoder } = require('../../src/encode/agentless-json')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

describe('AgentlessJSONEncoder', () => {
  let encoder
  let writer
  let metadata
  let data
  let childSpan

  beforeEach(() => {
    writer = { flush: sinon.stub() }
    metadata = {
      hostname: 'test-host',
      env: 'test-env',
      languageName: 'nodejs',
      languageVersion: 'v18.0.0',
      tracerVersion: '5.0.0',
      runtimeID: 'test-runtime-id',
    }
    encoder = new AgentlessJSONEncoder(writer, metadata)
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
    it('should encode a trace in the traces array format', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.ok(decoded.traces)
      assert.ok(Array.isArray(decoded.traces))
      assert.strictEqual(decoded.traces.length, 1)
      assert.ok(Array.isArray(decoded.traces[0].spans))
      assert.strictEqual(decoded.traces[0].spans.length, 1)
    })

    it('should encode IDs as lowercase hex strings', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0].spans[0]

      assertObjectContains(span, {
        trace_id: '1234abcd1234abcd',
        span_id: '5678efab5678efab',
        parent_id: '0000000000000000',
      })
    })

    it('should encode 128-bit trace IDs correctly', () => {
      // 128-bit trace IDs are used in W3C Trace Context
      data[0].trace_id = id('0123456789abcdef0123456789abcdef')

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0].spans[0]

      // Should be full 32-character hex string
      assert.strictEqual(span.trace_id, '0123456789abcdef0123456789abcdef')
      assert.strictEqual(span.trace_id.length, 32)
    })

    it('should include span fields with start time converted to seconds', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0].spans[0]

      assertObjectContains(span, {
        name: 'test',
        resource: 'test-resource',
        service: 'test-service',
        type: 'web',
        error: 0,
        start: 1234567890,
        duration: 5000000,
      })
      assert.deepStrictEqual(span.meta, { foo: 'bar', '_dd.compute_stats': '1' })
      assert.deepStrictEqual(span.metrics, { example: 1.5, _trace_root: 1 })
    })

    it('should handle multiple spans in one trace', () => {
      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces.length, 1)
      assert.strictEqual(decoded.traces[0].spans.length, 2)
    })

    it('should batch multiple traces in one payload', () => {
      encoder.encode(data)
      encoder.encode([childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces.length, 2)
      assert.strictEqual(decoded.traces[0].spans.length, 1)
      assert.strictEqual(decoded.traces[1].spans.length, 1)
    })

    it('should handle spans without optional fields', () => {
      delete data[0].type
      delete data[0].meta_struct
      delete data[0].links

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0].spans[0]

      assert.strictEqual(span.type, undefined)
      assert.strictEqual(span.meta_struct, undefined)
      assert.strictEqual(span.links, undefined)
    })

    it('should convert span_events to meta.events JSON string', () => {
      data[0].span_events = [{ name: 'exception', attributes: { message: 'error' } }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      const span = decoded.traces[0].spans[0]

      assert.strictEqual(span.span_events, undefined)
      assert.strictEqual(typeof span.meta.events, 'string')
      assert.deepStrictEqual(JSON.parse(span.meta.events), [{ name: 'exception', attributes: { message: 'error' } }])
    })

    it('should include meta_struct when present', () => {
      data[0].meta_struct = { nested: { key: 'value' } }

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.traces[0].spans[0].meta_struct, { nested: { key: 'value' } })
    })

    it('should include links when non-empty', () => {
      data[0].links = [{ trace_id: 'abc123', span_id: 'def456' }]

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.deepStrictEqual(decoded.traces[0].spans[0].links, [{ trace_id: 'abc123', span_id: 'def456' }])
    })

    it('should set _dd.compute_stats on the first span only', () => {
      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans[0].meta['_dd.compute_stats'], '1')
      assert.strictEqual(decoded.traces[0].spans[1].meta['_dd.compute_stats'], undefined)
    })

    it('should set _trace_root on spans with zero parent_id', () => {
      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans[0].metrics._trace_root, 1)
      assert.strictEqual(decoded.traces[0].spans[1].metrics._trace_root, undefined)
    })

    it('should set _top_level on spans marked as top-level', () => {
      data[0].metrics['_dd.top_level'] = 1

      encoder.encode([data[0], childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans[0].metrics._top_level, 1)
      assert.strictEqual(decoded.traces[0].spans[1].metrics._top_level, undefined)
    })

    it('should not set _top_level when _dd.top_level is 0', () => {
      data[0].metrics['_dd.top_level'] = 0

      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans[0].metrics._top_level, undefined)
    })

    it('should set _dd.compute_stats on next span when first span is malformed', () => {
      const badSpan = { name: 'bad' }

      encoder.encode([badSpan, childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans.length, 1)
      assert.strictEqual(decoded.traces[0].spans[0].meta['_dd.compute_stats'], '1')
    })

    it('should skip malformed spans and continue encoding', () => {
      const goodSpan = data[0]
      const badSpan = { name: 'bad' } // Missing required ID fields

      encoder.encode([goodSpan, badSpan])

      // Should have encoded only the good span
      assert.strictEqual(encoder.count(), 1)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      assert.strictEqual(decoded.traces[0].spans.length, 1)
      assert.strictEqual(decoded.traces[0].spans[0].name, 'test')
    })

    it('should drop entire trace when all spans fail to encode', () => {
      encoder.encode([null, null])

      assert.strictEqual(encoder.count(), 0)

      const buffer = encoder.makePayload()
      assert.strictEqual(buffer.length, 0)
    })

    it('should not affect other traces when one trace has all bad spans', () => {
      encoder.encode(data)
      encoder.encode([null, null])

      assert.strictEqual(encoder.count(), 1)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())
      assert.strictEqual(decoded.traces.length, 1)
    })

    it('should include metadata in each trace object', () => {
      encoder.encode(data)

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assertObjectContains(decoded.traces[0], {
        hostname: 'test-host',
        env: 'test-env',
        languageName: 'nodejs',
        languageVersion: 'v18.0.0',
        tracerVersion: '5.0.0',
        runtimeID: 'test-runtime-id',
      })
    })

    it('should set _dd.compute_stats on first span of each trace', () => {
      encoder.encode(data)
      encoder.encode([childSpan])

      const buffer = encoder.makePayload()
      const decoded = JSON.parse(buffer.toString())

      assert.strictEqual(decoded.traces[0].spans[0].meta['_dd.compute_stats'], '1')
      assert.strictEqual(decoded.traces[1].spans[0].meta['_dd.compute_stats'], '1')
    })

    it('should trigger writer flush when estimated size exceeds soft limit', () => {
      // Set estimated size just under the 8MB soft limit, then encode a span to push over
      encoder._estimatedSize = 8 * 1024 * 1024

      encoder.encode(data)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should not trigger writer flush when under soft limit', () => {
      encoder.encode(data)

      sinon.assert.notCalled(writer.flush)
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

      // Inject a malformed pre-serialized span to cause JSON assembly to fail
      encoder._traces[0] = ['{invalid json']
      // Inject circular metadata to trigger an error in JSON.stringify(this._metadata)
      const circular = {}
      circular.self = circular
      encoder._metadata = circular

      const buffer = encoder.makePayload()

      assert.strictEqual(buffer.length, 0)
      assert.strictEqual(encoder.count(), 0)
    })
  })
})
