'use strict'

const assert = require('assert')
const { describe, it } = require('tap').mocha

const NoopTracerProvider = require('../../../src/opentelemetry/noop/tracer_provider')

describe('NoopTracerProvider', () => {
  it('should store config and resource', () => {
    const config = { resource: 'test-resource' }
    const provider = new NoopTracerProvider(config)
    assert.strictEqual(provider.config, config)
    assert.strictEqual(provider.resource, 'test-resource')
  })

  it('should return same tracer for any name/version', () => {
    const provider = new NoopTracerProvider()
    const tracer1 = provider.getTracer('a', '1')
    const tracer2 = provider.getTracer('b', '2')
    assert.strictEqual(tracer1, tracer2)
  })

  it('should return same span for any name', () => {
    const provider = new NoopTracerProvider()
    const tracer = provider.getTracer()
    const span1 = tracer.startSpan('span1')
    const span2 = tracer.startSpan('span2')
    assert.strictEqual(span1, span2)
  })

  it('should return callback result from startActiveSpan', () => {
    const provider = new NoopTracerProvider()
    const tracer = provider.getTracer()
    const span1 = tracer.startActiveSpan('test', {})
    const span2 = tracer.startActiveSpan('test', {})
    assert.strictEqual(span1, span2)
  })

  it('should return same span processor instance', () => {
    const provider = new NoopTracerProvider()
    const processor1 = provider.getActiveSpanProcessor()
    const processor2 = provider.getActiveSpanProcessor()
    assert.strictEqual(processor1, processor2)
  })

  it('should not store processors', () => {
    const provider = new NoopTracerProvider()
    const processor = { onStart: () => {}, onEnd: () => {} }
    provider.addSpanProcessor(processor)
    assert.notStrictEqual(provider.getActiveSpanProcessor(), processor)
  })

  it('should return undefined from register', () => {
    const provider = new NoopTracerProvider()
    assert.strictEqual(provider.register(), undefined)
    assert.strictEqual(provider.register({}), undefined)
  })

  it('should return undefined from forceFlush', () => {
    const provider = new NoopTracerProvider()
    assert.strictEqual(provider.forceFlush(), undefined)
  })

  it('should return undefined from shutdown', () => {
    const provider = new NoopTracerProvider()
    assert.strictEqual(provider.shutdown(), undefined)
  })

  it('should return false from span.isRecording', () => {
    const provider = new NoopTracerProvider()
    const tracer = provider.getTracer()
    const span = tracer.startSpan('test')
    assert.strictEqual(span.isRecording(), false)
  })

  it('should return empty object from span.spanContext', () => {
    const provider = new NoopTracerProvider()
    const tracer = provider.getTracer()
    const span = tracer.startSpan('test')
    assert.deepStrictEqual(span.spanContext(), {})
  })

  it('should return undefined from span operations', () => {
    const provider = new NoopTracerProvider()
    const tracer = provider.getTracer()
    const span = tracer.startSpan('test')

    assert.strictEqual(span.setAttribute('key', 'value'), undefined)
    assert.strictEqual(span.setAttributes({ key: 'value' }), undefined)
    assert.strictEqual(span.addEvent('event'), undefined)
    assert.strictEqual(span.updateName('new-name'), undefined)
    assert.strictEqual(span.setStatus({ code: 1 }), undefined)
    assert.strictEqual(span.end(), undefined)
  })
})
