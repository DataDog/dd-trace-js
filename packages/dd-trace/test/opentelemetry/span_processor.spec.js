'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')

const {
  MultiSpanProcessor,
  NoopSpanProcessor
} = require('../../src/opentelemetry/span_processor')

class TestSpanProcessor extends NoopSpanProcessor {
  constructor () {
    super()

    this.forceFlush = sinon.stub().resolves()
    this.onStart = sinon.stub()
    this.onEnd = sinon.stub()
    this.shutdown = sinon.stub().resolves()
  }
}

t.test('OTel MultiSpanProcessor', t => {
  t.test('should call onStart', t => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onStart(1, 2)

    for (const processor of processors) {
      expect(processor.onStart).to.have.been.calledWith(1, 2)
    }
    t.end()
  })

  t.test('should call onEnd', t => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onEnd(3)

    for (const processor of processors) {
      expect(processor.onEnd).to.have.been.calledWith(3)
    }
    t.end()
  })

  t.test('should call flush', t => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.forceFlush()

    for (const processor of processors) {
      expect(processor.forceFlush).to.have.been.calledOnce
    }
    t.end()
  })

  t.test('should call onEnd', t => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.shutdown()

    for (const processor of processors) {
      expect(processor.shutdown).to.have.been.calledOnce
    }
    t.end()
  })
  t.end()
})
