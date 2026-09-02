'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
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

  it('only reports payloads accepted for serialization as enqueued', () => {
    const incrementCountMetric = sinon.spy()
    const TestBufferingExporter = proxyquire('../../../src/exporters/common/buffering-exporter', {
      '../../ci-visibility/telemetry': {
        incrementCountMetric,
        TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION: 'events_enqueued_for_serialization',
      },
    })
    const writer = {
      append: sinon.stub().onFirstCall().returns(false).onSecondCall().returns(true),
      flush: sinon.spy(),
    }
    const exporter = new TestBufferingExporter({ isCiVisibility: true, flushInterval: 0 })
    exporter._writer = writer
    exporter._isInitialized = true

    exporter.export([{}])
    exporter.export([{}])

    sinon.assert.calledOnceWithExactly(
      incrementCountMetric,
      'events_enqueued_for_serialization',
      {},
      1
    )
  })
})
