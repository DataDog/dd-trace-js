'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
const TelemetryDeliveryTracker = require('../../../src/serverless/telemetry-delivery-tracker')

describe('span-stats exporter', () => {
  let url
  let Exporter
  let exporter
  let Writer
  let writer
  let writerOptions
  let log
  let createServerlessDeliveryTracker

  beforeEach(() => {
    url = new URL('http://www.example.com:8126')
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
    }
    Writer = sinon.stub().callsFake(options => {
      writerOptions = options
      return writer
    })
    log = { error: sinon.spy() }
    createServerlessDeliveryTracker = sinon.stub().returns(new TelemetryDeliveryTracker())

    Exporter = proxyquire('../../../src/exporters/span-stats', {
      './writer': { Writer },
      '../../log': log,
      '../../serverless': { createServerlessDeliveryTracker },
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
    writer.flush.onFirstCall().callsFake(done => {
      writerOptions.deliveryTracker.track(callback => { inFlightDone = callback }, done)
    })
    writer.flush.onSecondCall().callsFake(done => done?.())
    const done = sinon.spy()

    exporter.export('in flight')
    exporter.flush(done)

    sinon.assert.notCalled(done)
    inFlightDone()
    sinon.assert.calledOnce(done)
  })

  it('waits for an encoder-triggered export during flush', () => {
    exporter = new Exporter({ url })
    let automaticDone
    writerOptions.deliveryTracker.track(done => { automaticDone = done })
    writer.flush = sinon.stub().callsFake(done => done?.())
    const done = sinon.spy()

    exporter.flush(done)

    sinon.assert.notCalled(done)
    automaticDone()
    sinon.assert.calledOnce(done)
  })

  it('waits for an encoder-triggered export during the flush boundary', () => {
    exporter = new Exporter({ url })
    let automaticDone
    writer.append = sinon.stub().callsFake(() => {
      writerOptions.deliveryTracker.track(done => { automaticDone = done })
    })
    writer.flush = sinon.stub().callsFake(done => done?.())
    const done = sinon.spy()

    exporter.export('boundary export', done)

    sinon.assert.notCalled(done)
    automaticDone()
    sinon.assert.calledOnce(done)
  })

  it('does not retain a failed writer flush', () => {
    writer.flush = sinon.stub()
    writer.flush.onFirstCall().throws(new Error('encode failed'))
    writer.flush.onSecondCall().callsFake(done => done?.())
    exporter = new Exporter({ url })
    const done = sinon.spy()

    assert.throws(() => exporter.export('failed export'), /encode failed/)
    exporter.flush(done)

    sinon.assert.calledOnce(done)
  })

  it('waits for an in-flight export when the boundary flush fails', () => {
    writer.flush = sinon.stub()
    let inFlightDone
    writer.flush.onFirstCall().callsFake(done => {
      writerOptions.deliveryTracker.track(callback => { inFlightDone = callback }, done)
    })
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

  it('waits for an in-flight export when boundary append fails', () => {
    let inFlightDone
    exporter = new Exporter({ url })
    writerOptions.deliveryTracker.track(callback => { inFlightDone = callback })
    writer.append = sinon.stub().throws(new Error('encode failed'))
    const done = sinon.spy()

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
    sinon.assert.calledWithMatch(Writer, {
      url: exporter._url,
    })
  })
})
