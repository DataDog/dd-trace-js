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
      flushDirect: sinon.spy(),
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
    sinon.assert.notCalled(writer.flushDirect)

    exporter.export('')

    sinon.assert.called(writer.append)
    sinon.assert.calledOnce(writer.flushDirect)
    sinon.assert.notCalled(writer.flush)
  })

  it('waits for an in-flight export at the next export boundary', () => {
    exporter = new Exporter({ url })
    let inFlightDone
    writer.flushDirect = sinon.stub()
    writer.flushDirect.onFirstCall().callsFake(done => { inFlightDone = done })
    writer.flushDirect.onSecondCall().callsFake(done => done())
    const done = sinon.spy()

    exporter.export('in flight')
    exporter.export('boundary', done)

    sinon.assert.notCalled(done)
    inFlightDone()
    sinon.assert.calledOnce(done)
  })

  it('detaches a cancelled export boundary from span statistics exports', () => {
    exporter = new Exporter({ url })
    const callbacks = []
    writer.flushDirect = sinon.stub().callsFake(done => callbacks.push(done))
    const done = sinon.spy()

    exporter.export('in flight')
    const cancel = exporter.export('boundary', done)
    cancel()
    callbacks[1]()
    callbacks[0]()

    sinon.assert.notCalled(done)
  })

  it('waits for an encoder-triggered export at the next export boundary', () => {
    exporter = new Exporter({ url })
    const onFlush = Writer.firstCall.args[0].onFlush
    let automaticDone
    onFlush(done => { automaticDone = done })
    writer.flushDirect = sinon.stub().callsFake(done => done())
    const done = sinon.spy()

    exporter.export('boundary', done)

    sinon.assert.notCalled(done)
    automaticDone()
    sinon.assert.calledOnce(done)
  })

  it('completes the encoder callback after its writer flush', () => {
    exporter = new Exporter({ url })
    const onFlush = Writer.firstCall.args[0].onFlush
    let requestDone
    const done = sinon.spy()

    onFlush(callback => { requestDone = callback }, done)

    sinon.assert.notCalled(done)
    requestDone()
    sinon.assert.calledOnce(done)
  })

  it('waits for an encoder-triggered export started by the boundary append', () => {
    exporter = new Exporter({ url })
    const onFlush = Writer.firstCall.args[0].onFlush
    let automaticDone
    writer.append = sinon.stub().callsFake(() => onFlush(done => { automaticDone = done }))
    writer.flushDirect = sinon.stub().callsFake(done => done())
    const done = sinon.spy()

    exporter.export('boundary', done)

    sinon.assert.notCalled(done)
    automaticDone()
    sinon.assert.calledOnce(done)
  })

  it('does not retain a failed writer flush', () => {
    writer.flushDirect = sinon.stub()
    writer.flushDirect.onFirstCall().throws(new Error('encode failed'))
    writer.flushDirect.onSecondCall().callsFake(done => done())
    exporter = new Exporter({ url })
    const done = sinon.spy()

    assert.throws(() => exporter.export('failed export'), /encode failed/)
    exporter.export('next export', done)

    sinon.assert.calledOnce(done)
  })

  it('waits for an in-flight export when the boundary flush fails', () => {
    writer.flushDirect = sinon.stub()
    let inFlightDone
    const boundaryError = null
    writer.flushDirect.onFirstCall().callsFake(done => { inFlightDone = done })
    writer.flushDirect.onSecondCall().callsFake(() => { throw boundaryError })
    exporter = new Exporter({ url })
    const done = sinon.spy()

    exporter.export('in flight')
    exporter.export('failed boundary', done)

    sinon.assert.notCalled(done)
    inFlightDone()
    sinon.assert.calledOnce(done)
    sinon.assert.calledOnceWithExactly(log.error, 'Failed to flush span stats: %s', null)
  })

  it('should set url from config', () => {
    const url = new URL('http://0.0.0.0:1234')

    exporter = new Exporter({ url })

    assert.strictEqual(exporter._url.toString(), url.toString())
    sinon.assert.calledWithMatch(Writer, {
      url: exporter._url,
    })
  })
})
