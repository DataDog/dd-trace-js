'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('span-stats exporter', () => {
  let url
  let Exporter
  let exporter
  let Writer
  let writer
  let log

  beforeEach(() => {
    url = new URL('http://www.example.com:8126')
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
    }
    Writer = sinon.stub().returns(writer)
    log = { error: sinon.spy() }

    Exporter = proxyquire('../../../src/exporters/span-stats', {
      './writer': { Writer },
      '../../log': log,
    }).SpanStatsExporter
  })

  it('should flush immediately on export', () => {
    exporter = new Exporter({ url })

    sinon.assert.notCalled(writer.append)
    sinon.assert.notCalled(writer.flush)

    exporter.export('')

    sinon.assert.called(writer.append)
    sinon.assert.called(writer.flush)
  })

  it('waits for an in-flight export during flush', () => {
    exporter = new Exporter({ url })
    let inFlightDone
    writer.flush = sinon.stub()
    writer.flush.onFirstCall().callsFake(done => { inFlightDone = done })
    writer.flush.onSecondCall().callsFake(done => done())
    const done = sinon.spy()

    exporter.export('in flight')
    exporter.flush(done)

    sinon.assert.notCalled(done)
    inFlightDone()
    sinon.assert.calledOnce(done)
  })

  it('does not retain a failed writer flush', () => {
    writer.flush = sinon.stub()
    writer.flush.onFirstCall().throws(new Error('encode failed'))
    writer.flush.onSecondCall().callsFake(done => done())
    exporter = new Exporter({ url })
    const done = sinon.spy()

    assert.throws(() => exporter.export('failed export'), /encode failed/)
    exporter.flush(done)

    sinon.assert.calledOnce(done)
  })

  it('waits for an in-flight export when the boundary flush fails', () => {
    writer.flush = sinon.stub()
    let inFlightDone
    writer.flush.onFirstCall().callsFake(done => { inFlightDone = done })
    writer.flush.onSecondCall().throws(new Error('encode failed'))
    exporter = new Exporter({ url })
    const done = sinon.spy()

    exporter.export('in flight')
    exporter.export('failed boundary', done)

    sinon.assert.notCalled(done)
    inFlightDone()
    sinon.assert.calledOnce(done)
    sinon.assert.calledOnceWithExactly(log.error, 'Failed to flush span stats: %s', 'encode failed')
  })

  it('should set url from config', () => {
    const url = new URL('http://0.0.0.0:1234')

    exporter = new Exporter({ url })

    assert.strictEqual(exporter._url.toString(), url.toString())
    sinon.assert.calledWith(Writer, {
      url: exporter._url,
    })
  })
})
