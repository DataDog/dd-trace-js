'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
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

  it('should register only once', () => {
    const api = {
      trace: {
        getTracerProvider: () => ({ setDelegate () {} }),
        setGlobalTracerProvider: sinon.stub().returns(true),
      },
      context: { setGlobalContextManager: sinon.spy() },
      propagation: { setGlobalPropagator: sinon.spy() },
    }
    const getApiOwner = sinon.stub().returns(api)
    const FreshTracerProvider = proxyquire('../../src/opentelemetry/tracer_provider', {
      './api': {
        getApiBinding: () => ({ current: { api, apiLogs: {} } }),
        getApiOwner,
      },
      '../../': {},
      './context_manager': class {},
      './tracer': class {},
      './span_processor': { MultiSpanProcessor: class {}, NoopSpanProcessor: class {} },
    })
    const provider = new FreshTracerProvider()

    provider.register()
    provider.register()

    sinon.assert.calledOnce(getApiOwner)
    sinon.assert.calledOnce(api.trace.setGlobalTracerProvider)
    sinon.assert.calledOnce(api.context.setGlobalContextManager)
    sinon.assert.calledOnce(api.propagation.setGlobalPropagator)
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
    assert.ok(provider.getActiveSpanProcessor() instanceof NoopSpanProcessor)

    // Swap out shutdown function to check if it's called
    const shutdown = sinon.stub()
    provider.getActiveSpanProcessor().shutdown = shutdown

    // After adding a span processor it should be a MultiSpanProcessor
    provider.addSpanProcessor(new NoopSpanProcessor())
    sinon.assert.calledOnce(shutdown)
    assert.ok(provider.getActiveSpanProcessor() instanceof MultiSpanProcessor)
  })

  it('should wire span processors passed through the constructor', () => {
    // @opentelemetry/sdk-node 0.220+ builds the provider from
    // @opentelemetry/sdk-trace 2.x, which hands processors to the constructor
    // instead of `addSpanProcessor`. A processor supplied that way has to reach
    // the active fan-out so a user's exporter still sees onStart/onEnd.
    const first = new NoopSpanProcessor()
    const second = new NoopSpanProcessor()
    first.onStart = sinon.stub()
    first.onEnd = sinon.stub()
    second.onStart = sinon.stub()
    second.onEnd = sinon.stub()

    const provider = new TracerProvider({ spanProcessors: [first, second] })

    const active = provider.getActiveSpanProcessor()
    assert.ok(active instanceof MultiSpanProcessor)

    const span = {}
    const context = {}
    active.onStart(span, context)
    active.onEnd(span)

    sinon.assert.calledOnceWithExactly(first.onStart, span, context)
    sinon.assert.calledOnceWithExactly(first.onEnd, span)
    sinon.assert.calledOnceWithExactly(second.onStart, span, context)
    sinon.assert.calledOnceWithExactly(second.onEnd, span)
  })

  it('should not register a constructor span processor twice', () => {
    const processor = new NoopSpanProcessor()
    processor.onStart = sinon.stub()
    processor.onEnd = sinon.stub()

    const provider = new TracerProvider({ spanProcessors: [processor] })
    provider.addSpanProcessor(processor)

    const span = {}
    const context = {}
    provider.getActiveSpanProcessor().onStart(span, context)
    provider.getActiveSpanProcessor().onEnd(span)

    sinon.assert.calledOnceWithExactly(processor.onStart, span, context)
    sinon.assert.calledOnceWithExactly(processor.onEnd, span)
  })

  it('should keep the noop processor when the constructor gets no processors', () => {
    assert.ok(new TracerProvider().getActiveSpanProcessor() instanceof NoopSpanProcessor)
    assert.ok(new TracerProvider({ spanProcessors: [] }).getActiveSpanProcessor() instanceof NoopSpanProcessor)
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

  it('registers through the compatibility-max owner when an application copy is selected', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().throws(notFound)
    const ownerCopy = {
      trace: {
        getTracerProvider: () => ({ setDelegate () {} }),
        setGlobalTracerProvider: sinon.stub().returns(true),
      },
      context: { setGlobalContextManager: sinon.spy() },
      propagation: { setGlobalPropagator: sinon.spy() },
    }
    const holder = proxyquire('../../src/opentelemetry/api', {
      'node:module': { createRequire: () => applicationRequire },
      '@opentelemetry/api': ownerCopy,
    })
    const applicationCopy = {
      trace: {
        getTracerProvider: () => ({ setDelegate () {} }),
        setGlobalTracerProvider: sinon.stub().returns(true),
      },
      context: { setGlobalContextManager: sinon.spy() },
      propagation: { setGlobalPropagator: sinon.spy() },
    }

    class ContextManager {}
    const FreshTracerProvider = proxyquire('../../src/opentelemetry/tracer_provider', {
      './api': holder,
      '../../': {},
      './context_manager': ContextManager,
      './tracer': class {},
      './span_processor': { MultiSpanProcessor: class {}, NoopSpanProcessor: class {} },
    })

    holder.setApi(applicationCopy, '1.0.0', false, { applicationOwned: true })

    const provider = new FreshTracerProvider()
    const propagator = {}
    provider.register({ propagator })

    assert.strictEqual(holder.getApi(), applicationCopy)
    sinon.assert.calledOnceWithExactly(ownerCopy.trace.setGlobalTracerProvider, provider)
    sinon.assert.calledOnceWithExactly(
      ownerCopy.context.setGlobalContextManager,
      sinon.match.instanceOf(ContextManager)
    )
    sinon.assert.calledOnceWithExactly(ownerCopy.propagation.setGlobalPropagator, propagator)
    sinon.assert.notCalled(applicationCopy.trace.setGlobalTracerProvider)
    sinon.assert.notCalled(applicationCopy.context.setGlobalContextManager)
    sinon.assert.notCalled(applicationCopy.propagation.setGlobalPropagator)
  })

  it('does not move an existing registration to a late application copy', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().throws(notFound)
    const ownerCopy = {
      trace: {
        disable: sinon.spy(),
        getTracerProvider: () => ({ setDelegate () {} }),
        setGlobalTracerProvider: sinon.stub().returns(true),
      },
      context: {
        disable: sinon.spy(),
        setGlobalContextManager: sinon.spy(),
      },
      propagation: {
        disable: sinon.spy(),
        setGlobalPropagator: sinon.spy(),
      },
    }
    const holder = proxyquire('../../src/opentelemetry/api', {
      'node:module': { createRequire: () => applicationRequire },
      '@opentelemetry/api': ownerCopy,
    })
    const applicationCopy = {
      trace: {
        disable: sinon.spy(),
        getTracerProvider: () => ({ setDelegate () {} }),
        setGlobalTracerProvider: sinon.stub().returns(true),
      },
      context: {
        disable: sinon.spy(),
        setGlobalContextManager: sinon.spy(),
      },
      propagation: {
        disable: sinon.spy(),
        setGlobalPropagator: sinon.spy(),
      },
    }

    const FreshTracerProvider = proxyquire('../../src/opentelemetry/tracer_provider', {
      './api': holder,
      '../../': {},
      './context_manager': class {},
      './tracer': class {},
      './span_processor': { MultiSpanProcessor: class {}, NoopSpanProcessor: class {} },
    })
    const provider = new FreshTracerProvider()
    provider.register()

    holder.setApi(applicationCopy, '1.9.0', false, { applicationOwned: true })

    assert.strictEqual(holder.getApi(), applicationCopy)
    sinon.assert.notCalled(ownerCopy.trace.disable)
    sinon.assert.notCalled(ownerCopy.context.disable)
    sinon.assert.notCalled(ownerCopy.propagation.disable)
    sinon.assert.notCalled(applicationCopy.trace.setGlobalTracerProvider)
    sinon.assert.notCalled(applicationCopy.context.setGlobalContextManager)
    sinon.assert.notCalled(applicationCopy.propagation.setGlobalPropagator)
  })
})
