'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')
const BufferingExporter = require('../../../src/exporters/common/buffering-exporter')

describe('BufferingExporter', () => {
  const writer = {
    append: sinon.spy(),
    flush: sinon.spy(),
    setUrl: sinon.spy(),
  }
  const flushInterval = 100
  const port = 8126

  it('should store traces as is when export is called before initialization', () => {
    const trace = [{ span_id: '1234' }]
    const exporter = new BufferingExporter({ port })

    exporter.export(trace)

    assert.deepStrictEqual(exporter.getUncodedTraces(), [trace])
  })

  it('should export if a writer is initialized', (done) => {
    const trace = [{ span_id: '1234' }]
    const exporter = new BufferingExporter({ port, flushInterval })

    exporter._writer = writer
    exporter._isInitialized = true
    exporter.export(trace)

    sinon.assert.calledWith(writer.append, trace)
    sinon.assert.notCalled(writer.flush)
    const uncodedTraces = exporter.getUncodedTraces()
    assert.ok(!uncodedTraces.includes(trace), `Got: ${inspect(uncodedTraces)}`)

    setTimeout(() => {
      sinon.assert.called(writer.flush)
      done()
    }, flushInterval)
  })

  it('should export buffered traces via exportUncodedTraces', () => {
    const trace1 = [{ span_id: '1234' }]
    const trace2 = [{ span_id: '5678' }]
    const exporter = new BufferingExporter({ port })

    exporter.export(trace1)
    exporter.export(trace2)

    assert.deepStrictEqual(exporter.getUncodedTraces(), [trace1, trace2])

    exporter._writer = writer
    exporter._isInitialized = true
    exporter.exportUncodedTraces()

    sinon.assert.calledWith(writer.append, trace1)
    sinon.assert.calledWith(writer.append, trace2)
    assert.deepStrictEqual(exporter.getUncodedTraces(), [])
  })

  it('should reset uncoded traces', () => {
    const trace = [{ span_id: '1234' }]
    const exporter = new BufferingExporter({ port })

    exporter.export(trace)
    assert.deepStrictEqual(exporter.getUncodedTraces(), [trace])

    exporter.resetUncodedTraces()
    assert.deepStrictEqual(exporter.getUncodedTraces(), [])
  })

  it('skips the periodic flush when _shouldFlush returns false', () => {
    const clock = sinon.useFakeTimers()
    try {
      const flushingWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
        setUrl: sinon.spy(),
      }
      const exporter = new BufferingExporter({ port, flushInterval })
      exporter._writer = flushingWriter
      exporter._isInitialized = true
      exporter._shouldFlush = () => false

      exporter.export([{ span_id: '1' }])
      clock.tick(flushInterval * 2)

      sinon.assert.called(flushingWriter.append)
      sinon.assert.notCalled(flushingWriter.flush)
    } finally {
      clock.restore()
    }
  })

  it('flushes on the periodic timer when _shouldFlush returns true', () => {
    const clock = sinon.useFakeTimers()
    try {
      const flushingWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
        setUrl: sinon.spy(),
      }
      const exporter = new BufferingExporter({ port, flushInterval })
      exporter._writer = flushingWriter
      exporter._isInitialized = true
      exporter._shouldFlush = () => true

      exporter.export([{ span_id: '1' }])
      clock.tick(flushInterval * 2)

      sinon.assert.called(flushingWriter.flush)
    } finally {
      clock.restore()
    }
  })

  it('re-arms the timer and flushes once saturation clears', () => {
    const clock = sinon.useFakeTimers()
    try {
      const flushingWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
        setUrl: sinon.spy(),
      }
      const exporter = new BufferingExporter({ port, flushInterval })
      exporter._writer = flushingWriter
      exporter._isInitialized = true
      let saturated = true
      exporter._shouldFlush = () => !saturated

      exporter.export([{ span_id: '1' }])
      // First tick: saturated, flush suppressed and timer re-armed.
      clock.tick(flushInterval)
      sinon.assert.notCalled(flushingWriter.flush)
      // Origin becomes idle; the re-armed timer fires and flushes.
      saturated = false
      clock.tick(flushInterval)
      sinon.assert.called(flushingWriter.flush)
    } finally {
      clock.restore()
    }
  })

  it('does not spin re-arming when the flush interval is non-finite', () => {
    const clock = sinon.useFakeTimers()
    try {
      const flushingWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
        setUrl: sinon.spy(),
      }
      const exporter = new BufferingExporter({ port, flushInterval: Infinity })
      exporter._writer = flushingWriter
      exporter._isInitialized = true
      exporter._shouldFlush = () => false

      exporter.export([{ span_id: '1' }])
      // setTimeout(Infinity) clamps to 1 ms; advance well past several clamped
      // intervals and assert the re-arm did not loop or flush.
      clock.tick(50)
      sinon.assert.called(flushingWriter.append)
      sinon.assert.notCalled(flushingWriter.flush)
    } finally {
      clock.restore()
    }
  })

  it('does not spin re-arming when the flush interval overflows the timer budget', () => {
    const clock = sinon.useFakeTimers()
    try {
      const flushingWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
        setUrl: sinon.spy(),
      }
      // 2^31 ms is Node's setTimeout ceiling; 2^32 is finite but overflowed.
      const exporter = new BufferingExporter({ port, flushInterval: 0x100000000 })
      exporter._writer = flushingWriter
      exporter._isInitialized = true
      exporter._shouldFlush = () => false

      exporter.export([{ span_id: '1' }])
      clock.tick(50)
      sinon.assert.called(flushingWriter.append)
      sinon.assert.notCalled(flushingWriter.flush)
    } finally {
      clock.restore()
    }
  })
})
