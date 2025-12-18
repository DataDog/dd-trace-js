'use strict'

/**
 * Integration tests for native spans mode.
 *
 * These tests verify that the tracer works correctly with native spans enabled.
 * They test the full span lifecycle: creation, tagging, finishing, and export.
 *
 * If the native module is not available, these tests will be skipped.
 */

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

const nativeModule = require('../../src/native')
const tags = require('../../../../ext/tags')

const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE

// Skip all tests if native spans module is not available
const nativeSpansUsable = nativeModule.available

if (!nativeSpansUsable) {
  describe('Native Spans Integration', () => {
    it('skipped - NativeSpanState not available', () => {
      // This test exists to indicate the suite was skipped
      assert.ok(true, 'Native spans tests skipped - NativeSpanState not available on this platform')
    })
  })

  describe('Native Spans Fallback', () => {
    it('skipped - NativeSpanState not available', () => {
      assert.ok(true, 'Native spans fallback tests skipped')
    })
  })
} else {

describe('Native Spans Integration', () => {
  let Tracer
  let tracer
  let config
  let exportedSpans

  beforeEach(() => {
    exportedSpans = []

    // Set env var before loading config
    process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED = 'true'

    // Clear require cache to get fresh modules
    delete require.cache[require.resolve('../../src/config')]
    delete require.cache[require.resolve('../../src/tracer')]

    // Get fresh config with native spans enabled via env var
    const getConfig = require('../../src/config')
    config = getConfig({
      service: 'test-service'
    })

    // Create tracer
    Tracer = require('../../src/tracer')
    tracer = new Tracer(config)

    // Stub the exporter to capture exported spans
    if (tracer._exporter && tracer._exporter.export) {
      sinon.stub(tracer._exporter, 'export').callsFake((spans) => {
        exportedSpans.push(...spans)
      })
    }
  })

  afterEach(() => {
    delete process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED
    sinon.restore()
  })

  describe('tracer initialization', () => {
    it('should initialize with native spans interface', () => {
      assert.ok(tracer._nativeSpans, 'tracer should have _nativeSpans')
    })

    it('should use native exporter', () => {
      const NativeExporter = require('../../src/exporters/native')
      assert.ok(tracer._exporter instanceof NativeExporter, 'should use NativeExporter')
    })
  })

  describe('span creation', () => {
    it('should create a native span via startSpan', () => {
      const span = tracer.startSpan('test-operation')

      assert.ok(span, 'span should be created')
      assert.ok(span.context(), 'span should have context')
      assert.ok(span.context()._nativeSpanId !== undefined, 'context should have native span ID')

      span.finish()
    })

    it('should create span with correct operation name', () => {
      const span = tracer.startSpan('my-operation')

      assert.strictEqual(span.context()._name, 'my-operation')

      span.finish()
    })

    it('should create span with tags', () => {
      const span = tracer.startSpan('tagged-span', {
        tags: {
          'custom.tag': 'custom-value',
          'numeric.tag': 42
        }
      })

      assert.strictEqual(span.context()._tags['custom.tag'], 'custom-value')
      assert.strictEqual(span.context()._tags['numeric.tag'], 42)

      span.finish()
    })

    it('should create span with service, resource, and type', () => {
      const span = tracer.startSpan('typed-span', {
        service: 'custom-service',
        resource: 'GET /api/users',
        type: 'web'
      })

      assert.strictEqual(span.context()._tags[SERVICE_NAME], 'custom-service')
      assert.strictEqual(span.context()._tags[RESOURCE_NAME], 'GET /api/users')
      assert.strictEqual(span.context()._tags[SPAN_TYPE], 'web')

      span.finish()
    })
  })

  describe('span operations', () => {
    let span

    beforeEach(() => {
      span = tracer.startSpan('test-span')
    })

    afterEach(() => {
      if (span && !span.context()._isFinished) {
        span.finish()
      }
    })

    it('should set operation name', () => {
      span.setOperationName('new-operation')

      assert.strictEqual(span.context()._name, 'new-operation')
    })

    it('should set tags via setTag', () => {
      span.setTag('http.url', 'https://example.com')
      span.setTag('http.status_code', 200)

      assert.strictEqual(span.context()._tags['http.url'], 'https://example.com')
      assert.strictEqual(span.context()._tags['http.status_code'], 200)
    })

    it('should set multiple tags via addTags', () => {
      span.addTags({
        'db.type': 'postgresql',
        'db.instance': 'users',
        'db.statement': 'SELECT * FROM users'
      })

      assert.strictEqual(span.context()._tags['db.type'], 'postgresql')
      assert.strictEqual(span.context()._tags['db.instance'], 'users')
      assert.strictEqual(span.context()._tags['db.statement'], 'SELECT * FROM users')
    })

    it('should set and get baggage items', () => {
      span.setBaggageItem('user-id', '12345')
      span.setBaggageItem('session-id', 'abc-def')

      assert.strictEqual(span.getBaggageItem('user-id'), '12345')
      assert.strictEqual(span.getBaggageItem('session-id'), 'abc-def')
    })

    it('should support method chaining', () => {
      const result = span
        .setOperationName('chained')
        .setTag('key1', 'value1')
        .addTags({ key2: 'value2' })
        .setBaggageItem('bag', 'item')

      assert.strictEqual(result, span)
    })
  })

  describe('span finishing', () => {
    it('should finish span and set duration', () => {
      const span = tracer.startSpan('finish-test')

      // Small delay to ensure measurable duration
      const start = Date.now()
      while (Date.now() - start < 5) { /* busy wait */ }

      span.finish()

      assert.ok(span._duration !== undefined, 'duration should be set')
      assert.ok(span._duration > 0, 'duration should be positive')
      assert.strictEqual(span.context()._isFinished, true)
    })

    it('should only finish once', () => {
      const span = tracer.startSpan('double-finish')
      const processSpy = sinon.spy(tracer._processor, 'process')

      span.finish()
      span.finish()

      assert.strictEqual(processSpy.callCount, 1, 'process should only be called once')
    })

    it('should accept explicit finish time', () => {
      const span = tracer.startSpan('explicit-finish', {
        startTime: 1000
      })

      span.finish(1500)

      assert.ok(span._duration !== undefined)
    })
  })

  describe('parent-child relationships', () => {
    it('should create child span with parent reference', () => {
      const parent = tracer.startSpan('parent-span')
      const child = tracer.startSpan('child-span', {
        childOf: parent
      })

      assert.strictEqual(
        child.context()._traceId.toString(),
        parent.context()._traceId.toString(),
        'child should share trace ID with parent'
      )
      assert.strictEqual(
        child.context()._parentId.toString(),
        parent.context()._spanId.toString(),
        'child parent ID should be parent span ID'
      )

      child.finish()
      parent.finish()
    })

    it('should create child span from active span in scope', () => {
      const parent = tracer.startSpan('parent')

      tracer.scope().activate(parent, () => {
        const child = tracer.startSpan('child')

        assert.strictEqual(
          child.context()._parentId.toString(),
          parent.context()._spanId.toString()
        )

        child.finish()
      })

      parent.finish()
    })

    it('should share trace object between parent and child', () => {
      const parent = tracer.startSpan('parent')
      const child = tracer.startSpan('child', { childOf: parent })

      assert.strictEqual(child.context()._trace, parent.context()._trace)

      child.finish()
      parent.finish()
    })
  })

  describe('span links', () => {
    it('should add span links', () => {
      const linkedSpan = tracer.startSpan('linked-span')
      linkedSpan.finish()

      const span = tracer.startSpan('span-with-link')
      span.addLink({
        context: linkedSpan.context(),
        attributes: { 'link.reason': 'test' }
      })

      assert.strictEqual(span._links.length, 1)
      assert.strictEqual(span._links[0].attributes['link.reason'], 'test')

      span.finish()
    })

    it('should serialize links on finish', () => {
      const linkedSpan = tracer.startSpan('linked')
      linkedSpan.finish()

      const span = tracer.startSpan('with-links')
      span.addLink({ context: linkedSpan.context() })
      span.finish()

      const linksTag = span.context()._tags['_dd.span_links']
      assert.ok(linksTag, 'should have _dd.span_links tag')

      const links = JSON.parse(linksTag)
      assert.strictEqual(links.length, 1)
    })
  })

  describe('span events', () => {
    it('should add span events', () => {
      const span = tracer.startSpan('span-with-events')

      span.addEvent('event-1', { key: 'value' })
      span.addEvent('event-2', { count: 42 })

      assert.strictEqual(span._events.length, 2)
      assert.strictEqual(span._events[0].name, 'event-1')
      assert.strictEqual(span._events[1].name, 'event-2')

      span.finish()
    })

    it('should serialize events on finish', () => {
      const span = tracer.startSpan('with-events')
      span.addEvent('test-event', { foo: 'bar' })
      span.finish()

      const eventsTag = span.context()._tags['_dd.span_events']
      assert.ok(eventsTag, 'should have _dd.span_events tag')

      const events = JSON.parse(eventsTag)
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0].name, 'test-event')
    })
  })

  describe('trace method', () => {
    it('should run callback with span', () => {
      let capturedSpan

      tracer.trace('traced-operation', {}, (span) => {
        capturedSpan = span
        assert.ok(span.context()._nativeSpanId !== undefined)
      })

      assert.ok(capturedSpan)
      assert.strictEqual(capturedSpan.context()._isFinished, true)
    })

    it('should return value from callback', () => {
      const result = tracer.trace('returning', {}, () => 'test-result')

      assert.strictEqual(result, 'test-result')
    })

    it('should handle errors in callback', () => {
      const error = new Error('test error')
      let caughtError

      try {
        tracer.trace('erroring', {}, () => {
          throw error
        })
      } catch (e) {
        caughtError = e
      }

      assert.strictEqual(caughtError, error)
    })

    it('should accept options', () => {
      tracer.trace('with-options', {
        service: 'option-service',
        resource: 'option-resource',
        type: 'option-type',
        tags: { custom: 'tag' }
      }, (span) => {
        assert.strictEqual(span.context()._tags[SERVICE_NAME], 'option-service')
        assert.strictEqual(span.context()._tags[RESOURCE_NAME], 'option-resource')
        assert.strictEqual(span.context()._tags[SPAN_TYPE], 'option-type')
        assert.strictEqual(span.context()._tags.custom, 'tag')
      })
    })
  })

  describe('wrap method', () => {
    it('should wrap a function', () => {
      const fn = (a, b) => a + b
      const wrapped = tracer.wrap('wrapped-fn', {}, fn)

      const result = wrapped(1, 2)

      assert.strictEqual(result, 3)
    })

    it('should create span when wrapped function is called', () => {
      let capturedSpan

      const fn = () => {
        capturedSpan = tracer.scope().active()
      }
      const wrapped = tracer.wrap('wrapped', {}, fn)

      wrapped()

      assert.ok(capturedSpan)
      assert.ok(capturedSpan.context()._nativeSpanId !== undefined)
    })
  })

  describe('context propagation', () => {
    it('should inject context into carrier', () => {
      const span = tracer.startSpan('inject-test')
      const carrier = {}

      tracer.inject(span.context(), 'text_map', carrier)

      assert.ok('x-datadog-trace-id' in carrier || 'traceparent' in carrier,
        'carrier should have trace headers')

      span.finish()
    })

    it('should extract context from carrier', () => {
      const span = tracer.startSpan('extract-source')
      const carrier = {}

      tracer.inject(span.context(), 'text_map', carrier)

      const extractedContext = tracer.extract('text_map', carrier)

      assert.ok(extractedContext, 'should extract context')
      assert.strictEqual(
        extractedContext._traceId.toString(),
        span.context()._traceId.toString()
      )

      span.finish()
    })
  })

  describe('export behavior', () => {
    it('should export finished spans', (done) => {
      const span = tracer.startSpan('export-test')
      span.setTag('test.tag', 'test-value')
      span.finish()

      // Give time for export to happen
      setTimeout(() => {
        assert.ok(exportedSpans.length > 0, 'should have exported spans')

        const exported = exportedSpans.find(s =>
          s.context()._name === 'export-test'
        )
        assert.ok(exported, 'should find our span in exports')

        done()
      }, 50)
    })

    it('should export parent-child trace together', (done) => {
      const parent = tracer.startSpan('parent')
      const child = tracer.startSpan('child', { childOf: parent })

      child.finish()
      parent.finish()

      setTimeout(() => {
        const parentExport = exportedSpans.find(s =>
          s.context()._name === 'parent'
        )
        const childExport = exportedSpans.find(s =>
          s.context()._name === 'child'
        )

        assert.ok(parentExport, 'parent should be exported')
        assert.ok(childExport, 'child should be exported')

        done()
      }, 50)
    })
  })
})

// Test that native mode can be disabled and falls back to JS
describe('Native Spans Fallback', () => {
  let Tracer
  let tracer
  let config

  beforeEach(() => {
    // Native spans are disabled by default, no env var or option needed
    const getConfig = require('../../src/config')
    config = getConfig({
      service: 'test-service'
    })

    Tracer = require('../../src/tracer')
    tracer = new Tracer(config)
  })

  it('should not use native spans when disabled', () => {
    assert.strictEqual(tracer._nativeSpans, null, 'should not have native spans')
  })

  it('should still create spans normally', () => {
    const span = tracer.startSpan('js-span')

    assert.ok(span)
    assert.ok(span.context())

    span.finish()
  })
})

} // end of else block for nativeSpansUsable
