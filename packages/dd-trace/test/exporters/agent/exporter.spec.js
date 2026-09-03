'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
const TelemetryDeliveryTracker = require('../../../src/serverless/telemetry-delivery-tracker')

describe('Exporter', () => {
  let url
  let flushInterval
  let Exporter
  let exporter
  let Writer
  let writer
  let prioritySampler
  let span
  let writerOptions
  let createServerlessDeliveryTracker

  beforeEach(() => {
    url = 'http://www.example.com:8126'
    flushInterval = 1000
    span = {}
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy(),
    }
    prioritySampler = {}
    Writer = sinon.stub().callsFake(options => {
      writerOptions = options
      return writer
    })
    createServerlessDeliveryTracker = sinon.stub()

    Exporter = proxyquire('../../../src/exporters/agent', {
      './writer': Writer,
      '../../serverless': { createServerlessDeliveryTracker },
    })
  })

  it('should pass computed stats header through to writer', () => {
    const stats = { DD_TRACE_STATS_COMPUTATION_ENABLED: true }
    exporter = new Exporter({ url, flushInterval, stats }, prioritySampler)
    sinon.assert.calledWithMatch(Writer, {
      headers: {
        'Datadog-Client-Computed-Stats': 'yes',
      },
    })
  })

  it('should pass computed stats header through to writer if APM Tracing is disabled', () => {
    const stats = { DD_TRACE_STATS_COMPUTATION_ENABLED: false }
    const apmTracingEnabled = false
    exporter = new Exporter({ url, flushInterval, stats, apmTracingEnabled }, prioritySampler)

    sinon.assert.calledWithMatch(Writer, {
      headers: {
        'Datadog-Client-Computed-Stats': 'yes',
      },
    })
  })

  it('should forward an IPv6 agent URL to the writer', () => {
    const stats = { DD_TRACE_STATS_COMPUTATION_ENABLED: true }
    const url = new URL('http://[::1]:8126/')
    exporter = new Exporter({ url, flushInterval, stats }, prioritySampler)
    sinon.assert.calledWithMatch(Writer, { url })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    it('should pass the interval to the writer', () => {
      assert.strictEqual(writerOptions.flushInterval, flushInterval)
    })

    it('should not flush if export has not been called', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      setTimeout(() => {
        sinon.assert.notCalled(writer.flush)
        done()
      }, flushInterval + 100)
    })

    it('should flush after the configured interval if a payload has been exported', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      exporter.export([{}])
      setTimeout(() => {
        sinon.assert.called(writer.flush)
        done()
      }, flushInterval + 100)
    })

    describe('export', () => {
      beforeEach(() => {
        span = {}
      })

      it('should export a span', () => {
        writer.length = 0
        exporter.export([span])

        sinon.assert.calledWith(writer.append, [span])
      })
    })
  })

  describe('when interval is set to 0', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval: 0 })
    })

    it('should pass the interval to the writer', () => {
      assert.strictEqual(writerOptions.flushInterval, 0)
    })

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      sinon.assert.called(writer.flush)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      createServerlessDeliveryTracker.returns(new TelemetryDeliveryTracker())
    })

    it('waits for trace exports already in flight', () => {
      const callbacks = []
      writer.flush = sinon.spy(done => {
        writerOptions.deliveryTracker.track(callback => callbacks.push(callback), done)
      })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      exporter.flush(flushed)

      callbacks[1]()
      sinon.assert.notCalled(flushed)
      callbacks[0]()
      sinon.assert.calledOnce(flushed)
    })

    it('waits for an encoder-triggered writer flush already in flight', () => {
      const callbacks = []
      const flushDirect = sinon.spy(done => callbacks.push(done))
      writer.flushDirect = flushDirect
      writer.flush = sinon.spy(done => writerOptions.deliveryTracker.track(flushDirect, done))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      // This is the path the encoder uses when it crosses its soft limit.
      exporter._writer.flush()
      exporter.flush(flushed)

      callbacks[1]()
      sinon.assert.notCalled(flushed)
      callbacks[0]()
      sinon.assert.calledOnce(flushed)
    })

    it('does not retain a failed writer flush', () => {
      writer.flush = sinon.stub()
      writer.flush.onFirstCall().throws(new Error('encode failed'))
      writer.flush.onSecondCall().callsFake(done => done())
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      assert.throws(() => exporter.export([span]), /encode failed/)
      exporter.flush(flushed)

      sinon.assert.calledOnce(flushed)
    })

    it('waits for an earlier export when the boundary flush fails', () => {
      let inFlightDone
      writer.flush = sinon.stub()
      writer.flush.onFirstCall().callsFake(done => {
        writerOptions.deliveryTracker.track(callback => { inFlightDone = callback }, done)
      })
      writer.flush.onSecondCall().throws(new Error('encode failed'))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      exporter.flush(flushed)

      sinon.assert.notCalled(flushed)
      inFlightDone()
      sinon.assert.calledOnce(flushed)
    })

    it('waits for the boundary export without serverless retention', () => {
      createServerlessDeliveryTracker.resetBehavior()
      let complete
      writer.flush = sinon.stub().callsFake(done => { complete = done })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.flush(flushed)

      sinon.assert.notCalled(flushed)
      complete()
      sinon.assert.calledOnce(flushed)
    })

    it('reports a serverless delivery failure when requested', () => {
      const error = new Error('agent failed')
      writer.flush = sinon.spy(done => {
        writerOptions.deliveryTracker.track(complete => complete(error), done)
      })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.flush(flushed, { reportErrors: true })

      sinon.assert.calledOnceWithExactly(flushed, error)
    })

    it('does not report a serverless delivery failure by default', () => {
      writer.flush = sinon.spy(done => {
        writerOptions.deliveryTracker.track(complete => complete(new Error('agent failed')), done)
      })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.flush(flushed)

      sinon.assert.calledOnceWithExactly(flushed, undefined)
    })

    it('supports a serverless flush without a completion callback', () => {
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)

      exporter.flush()

      sinon.assert.calledOnce(writer.flush)
    })

    it('aggregates a synchronous boundary failure with an in-flight failure', () => {
      const inFlightError = new Error('in-flight request failed')
      const boundaryError = new Error('boundary flush failed')
      let completeInFlight
      writer.flush = sinon.stub()
      writer.flush.onFirstCall().callsFake(done => {
        writerOptions.deliveryTracker.track(complete => { completeInFlight = complete }, done)
      })
      writer.flush.onSecondCall().callsFake(done => {
        writerOptions.deliveryTracker.track(() => { throw boundaryError }, done)
      })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      exporter.flush(flushed, { reportErrors: true })
      sinon.assert.notCalled(flushed)
      completeInFlight(inFlightError)

      sinon.assert.calledOnce(flushed)
      const error = flushed.firstCall.firstArg
      assert.ok(error instanceof AggregateError)
      assert.deepStrictEqual(error.errors, [boundaryError, inFlightError])
    })

    it('reports a boundary flush failure when requested', () => {
      createServerlessDeliveryTracker.resetBehavior()
      const error = new Error('encode failed')
      writer.flush = sinon.stub().throws(error)
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.flush(flushed, { reportErrors: true })

      sinon.assert.calledOnceWithExactly(flushed, error)
    })

    it('does not report a boundary flush failure by default', () => {
      createServerlessDeliveryTracker.resetBehavior()
      writer.flush = sinon.stub().throws(new Error('encode failed'))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.flush(flushed)

      sinon.assert.calledOnceWithExactly(flushed, undefined)
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      exporter = new Exporter({ url })
    })

    it('should set the URL on self and writer', () => {
      exporter.setUrl('http://example2.com')
      const url = new URL('http://example2.com')
      assert.deepStrictEqual(exporter._url, url)
      sinon.assert.calledWith(writer.setUrl, url)
    })
  })
})
