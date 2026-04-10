'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { trace } = require('@opentelemetry/api')

require('../setup/core')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const Tracer = require('../../src/opentelemetry/tracer')
const { MultiSpanProcessor, NoopSpanProcessor } = require('../../src/opentelemetry/span_processor')
require('../../index').init()

describe('OTel TracerProvider', () => {
  it('should register with OTel API', () => {
    const provider = new TracerProvider()
    provider.register()

    assert.strictEqual(trace.getTracerProvider().getDelegate(), provider)
  })

  it('should get tracer', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer()

    assert.ok(tracer instanceof Tracer)
    assert.strictEqual(tracer, provider.getTracer())
  })

  it('should get unique tracers by name and version key', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer('a', '1')

    assert.strictEqual(tracer, provider.getTracer('a', '1'))
    assert.notStrictEqual(tracer, provider.getTracer('a', '2'))
    assert.notStrictEqual(tracer, provider.getTracer('b', '1'))
  })

  it('should get active span processor', () => {
    const provider = new TracerProvider()

    // Initially is a NoopSpanProcessor
    assert.strictEqual(provider._processors.length, 0)
    assert.ok(provider.getActiveSpanProcessor() instanceof NoopSpanProcessor)

    // Swap out shutdown function to check if it's called
    const shutdown = sinon.stub()
    provider.getActiveSpanProcessor().shutdown = shutdown

    // After adding a span processor it should be a MultiSpanProcessor
    provider.addSpanProcessor(new NoopSpanProcessor())
    sinon.assert.calledOnce(shutdown)
    assert.strictEqual(provider._processors.length, 1)
    assert.ok(provider.getActiveSpanProcessor() instanceof MultiSpanProcessor)
  })

  it('should delegate shutdown to active span processor', () => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.shutdown = sinon.stub()

    provider.shutdown()
    sinon.assert.calledOnce(processor.shutdown)
  })

  it('should delegate forceFlush to active span processor', () => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.forceFlush = sinon.stub()

    provider.forceFlush()
    sinon.assert.calledOnce(processor.forceFlush)
  })
})

describe('TracerProvider getter without @opentelemetry/api', () => {
  const noopCheckPeerDeps = { checkOpenTelemetryAPIDeps: () => false }
  const expectedMessage =
    '@opentelemetry/api is required to use TracerProvider. Install it with: npm install @opentelemetry/api'

  it('should throw when instantiated via main proxy', () => {
    const TracerProxy = proxyquire.noPreserveCache()('../../src/proxy', {
      './opentelemetry/check_peer_deps': noopCheckPeerDeps,
    })
    const getter = Object.getOwnPropertyDescriptor(TracerProxy.prototype, 'TracerProvider').get
    const NoopClass = getter.call({})
    assert.throws(() => new NoopClass(), { message: expectedMessage })
  })

  it('should throw when instantiated via noop proxy', () => {
    const NoopProxy = proxyquire.noPreserveCache()('../../src/noop/proxy', {
      '../opentelemetry/check_peer_deps': noopCheckPeerDeps,
    })
    const getter = Object.getOwnPropertyDescriptor(NoopProxy.prototype, 'TracerProvider').get
    const NoopClass = getter.call({})
    assert.throws(() => new NoopClass(), { message: expectedMessage })
  })
})
