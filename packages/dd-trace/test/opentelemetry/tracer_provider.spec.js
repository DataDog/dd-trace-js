'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')

const { trace } = require('@opentelemetry/api')

const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const Tracer = require('../../src/opentelemetry/tracer')

const { MultiSpanProcessor, NoopSpanProcessor } = require('../../src/opentelemetry/span_processor')

require('../../index').init()

t.test('OTel TracerProvider', t => {
  t.test('should register with OTel API', t => {
    const provider = new TracerProvider()
    provider.register()

    expect(trace.getTracerProvider().getDelegate()).to.equal(provider)
    t.end()
  })

  t.test('should get tracer', t => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer()

    expect(tracer).to.be.an.instanceOf(Tracer)
    expect(tracer).to.equal(provider.getTracer())
    t.end()
  })

  t.test('should get unique tracers by name and version key', t => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer('a', '1')

    expect(tracer).to.equal(provider.getTracer('a', '1'))
    expect(tracer).to.not.equal(provider.getTracer('a', '2'))
    expect(tracer).to.not.equal(provider.getTracer('b', '1'))
    t.end()
  })

  t.test('should get active span processor', t => {
    const provider = new TracerProvider()

    // Initially is a NoopSpanProcessor
    expect(provider._processors.length).to.equal(0)
    expect(provider.getActiveSpanProcessor()).to.be.an.instanceOf(NoopSpanProcessor)

    // Swap out shutdown function to check if it's called
    const shutdown = sinon.stub()
    provider.getActiveSpanProcessor().shutdown = shutdown

    // After adding a span processor it should be a MultiSpanProcessor
    provider.addSpanProcessor(new NoopSpanProcessor())
    expect(shutdown).to.have.been.calledOnce
    expect(provider._processors.length).to.equal(1)
    expect(provider.getActiveSpanProcessor()).to.be.an.instanceOf(MultiSpanProcessor)
    t.end()
  })

  t.test('should delegate shutdown to active span processor', t => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.shutdown = sinon.stub()

    provider.shutdown()
    expect(processor.shutdown).to.have.been.calledOnce
    t.end()
  })

  t.test('should delegate forceFlush to active span processor', t => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.forceFlush = sinon.stub()

    provider.forceFlush()
    expect(processor.forceFlush).to.have.been.calledOnce
    t.end()
  })
  t.end()
})
