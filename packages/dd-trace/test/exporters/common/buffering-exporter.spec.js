'use strict'

const assert = require('node:assert/strict')

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
    assert.ok(!(exporter.getUncodedTraces()).includes(trace))

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
})
