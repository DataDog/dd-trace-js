'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const sinon = require('sinon')
const { trace } = require('@opentelemetry/api')

require('../setup/core')

const TracerProvider = require('../../src/opentelemetry/tracer-provider')
const Tracer = require('../../src/opentelemetry/tracer')

const { MultiSpanProcessor, NoopSpanProcessor } = require('../../src/opentelemetry/span-processor')

require('../../index').init()

describe('OTel TracerProvider', () => {
  it('should register with OTel API', () => {
    const provider = new TracerProvider()
    provider.register()

    expect(trace.getTracerProvider().getDelegate()).to.equal(provider)
  })

  it('should get tracer', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer()

    expect(tracer).to.be.an.instanceOf(Tracer)
    expect(tracer).to.equal(provider.getTracer())
  })

  it('should get unique tracers by name and version key', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer('a', '1')

    expect(tracer).to.equal(provider.getTracer('a', '1'))
    expect(tracer).to.not.equal(provider.getTracer('a', '2'))
    expect(tracer).to.not.equal(provider.getTracer('b', '1'))
  })

  it('should get active span processor', () => {
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
  })

  it('should delegate shutdown to active span processor', () => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.shutdown = sinon.stub()

    provider.shutdown()
    expect(processor.shutdown).to.have.been.calledOnce
  })

  it('should delegate forceFlush to active span processor', () => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.forceFlush = sinon.stub()

    provider.forceFlush()
    expect(processor.forceFlush).to.have.been.calledOnce
  })
})
