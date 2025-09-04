'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

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

describe('OTel MultiSpanProcessor', () => {
  it('should call onStart', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onStart(1, 2)

    for (const processor of processors) {
      expect(processor.onStart).to.have.been.calledWith(1, 2)
    }
  })

  it('should call onEnd', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onEnd(3)

    for (const processor of processors) {
      expect(processor.onEnd).to.have.been.calledWith(3)
    }
  })

  it('should call flush', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.forceFlush()

    for (const processor of processors) {
      expect(processor.forceFlush).to.have.been.calledOnce
    }
  })

  it('should call onEnd', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor()
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.shutdown()

    for (const processor of processors) {
      expect(processor.shutdown).to.have.been.calledOnce
    }
  })
})
