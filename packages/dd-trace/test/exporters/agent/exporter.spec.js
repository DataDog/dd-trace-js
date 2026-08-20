'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

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
  let clock

  beforeEach(() => {
    url = 'http://www.example.com:8126'
    flushInterval = 1000
    span = {}
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      flushDirect: sinon.spy(),
      setUrl: sinon.spy(),
    }
    prioritySampler = {}
    Writer = sinon.stub().callsFake(options => {
      writerOptions = options
      return writer
    })

    Exporter = proxyquire('../../../src/exporters/agent', {
      './writer': Writer,
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
      clock = sinon.useFakeTimers()
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    afterEach(() => {
      clock.restore()
    })

    it('should not flush if export has not been called', () => {
      clock.tick(flushInterval + 100)

      sinon.assert.notCalled(writer.flushDirect)
    })

    it('should flush after the configured interval if a payload has been exported', () => {
      exporter.export([{}])
      clock.tick(flushInterval + 100)

      sinon.assert.called(writer.flushDirect)
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

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      sinon.assert.calledOnce(writer.flushDirect)
      sinon.assert.notCalled(writer.flush)
    })
  })

  describe('flush', () => {
    it('waits for trace exports already in flight', () => {
      const callbacks = []
      writer.flushDirect = sinon.spy(done => callbacks.push(done))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      exporter.flush(flushed)

      callbacks[1]()
      sinon.assert.notCalled(flushed)
      callbacks[0]()
      sinon.assert.calledOnce(flushed)
    })

    it('detaches a cancelled flush boundary from exports already in flight', () => {
      const callbacks = []
      writer.flushDirect = sinon.spy(done => callbacks.push(done))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      const cancel = exporter.flush(flushed)
      cancel()

      callbacks[1]()
      callbacks[0]()
      sinon.assert.notCalled(flushed)
    })

    it('waits for an encoder-triggered writer flush already in flight', () => {
      const callbacks = []
      const flushDirect = sinon.spy(done => callbacks.push(done))
      writer.flushDirect = flushDirect
      writer.flush = sinon.spy(done => writerOptions.onFlush(flushDirect, done))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      // This is the path the encoder uses when it crosses its soft limit.
      writer.flush()
      exporter.flush(flushed)

      callbacks[1]()
      sinon.assert.notCalled(flushed)
      callbacks[0]()
      sinon.assert.calledOnce(flushed)
    })

    it('completes the encoder callback after its writer flush', () => {
      let requestDone
      const flushDirect = sinon.spy(done => { requestDone = done })
      writer.flushDirect = flushDirect
      writer.flush = sinon.spy(done => writerOptions.onFlush(flushDirect, done))
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const done = sinon.spy()

      writer.flush(done)

      sinon.assert.notCalled(done)
      requestDone()
      sinon.assert.calledOnce(done)
    })

    it('does not retain a failed writer flush', () => {
      writer.flushDirect = sinon.stub()
      writer.flushDirect.onFirstCall().throws(new Error('encode failed'))
      writer.flushDirect.onSecondCall().callsFake(done => done())
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      assert.throws(() => exporter.export([span]), /encode failed/)
      exporter.flush(flushed)

      sinon.assert.calledOnce(flushed)
    })

    it('waits for an earlier export when the boundary flush fails', () => {
      let inFlightDone
      const boundaryError = null
      writer.flushDirect = sinon.stub()
      writer.flushDirect.onFirstCall().callsFake(done => { inFlightDone = done })
      writer.flushDirect.onSecondCall().callsFake(() => { throw boundaryError })
      exporter = new Exporter({ url, flushInterval: 0 }, prioritySampler)
      const flushed = sinon.spy()

      exporter.export([span])
      exporter.flush(flushed)

      sinon.assert.notCalled(flushed)
      inFlightDone()
      sinon.assert.calledOnce(flushed)
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
