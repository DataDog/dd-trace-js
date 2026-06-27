'use strict'

const { describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const {
  MultiSpanProcessor,
  NoopSpanProcessor,
} = require('../../src/opentelemetry/span_processor')

class TestSpanProcessor extends NoopSpanProcessor {
  constructor () {
    super()

    this.forceFlush = sinon.stub().resolves()
    this.onStart = sinon.stub()
    this.onEnding = sinon.stub()
    this.onEnd = sinon.stub()
    this.shutdown = sinon.stub().resolves()
  }
}

describe('OTel MultiSpanProcessor', () => {
  it('should call onStart', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor(),
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onStart(1, 2)

    for (const processor of processors) {
      sinon.assert.calledWith(processor.onStart, 1, 2)
    }
  })

  it('should call onEnding', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor(),
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onEnding(3)

    for (const processor of processors) {
      sinon.assert.calledWith(processor.onEnding, 3)
    }
  })

  it('should skip a child processor that does not implement onEnding', () => {
    // `onEnding` is an experimental OTel hook; a user-registered processor need not implement it.
    const withHook = new TestSpanProcessor()
    const withoutHook = { onStart () {}, onEnd () {}, forceFlush () {}, shutdown () {} }

    const processor = new MultiSpanProcessor([withoutHook, withHook])
    processor.onEnding(3)

    sinon.assert.calledWith(withHook.onEnding, 3)
  })

  it('should call onEnd', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor(),
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.onEnd(3)

    for (const processor of processors) {
      sinon.assert.calledWith(processor.onEnd, 3)
    }
  })

  it('should call flush', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor(),
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.forceFlush()

    for (const processor of processors) {
      sinon.assert.calledOnce(processor.forceFlush)
    }
  })

  it('should call onEnd', () => {
    const processors = [
      new TestSpanProcessor(),
      new TestSpanProcessor(),
    ]

    const processor = new MultiSpanProcessor(processors)
    processor.shutdown()

    for (const processor of processors) {
      sinon.assert.calledOnce(processor.shutdown)
    }
  })
})
