'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('ElectronExporter', () => {
  let Exporter
  let exporter
  let traceChannel
  let truncateSpan
  let normalizeSpan
  let span
  let config

  beforeEach(() => {
    span = { name: 'test', service: 'my-service', meta: {}, metrics: {} }
    config = { flushInterval: 1000 }

    traceChannel = {
      hasSubscribers: true,
      publish: sinon.spy(),
    }

    truncateSpan = sinon.stub().callsFake(s => s)
    normalizeSpan = sinon.stub().callsFake(s => s)

    Exporter = proxyquire('../../../src/exporters/electron', {
      'dc-polyfill': { channel: sinon.stub().returns(traceChannel) },
      '../../encode/tags-processors': { truncateSpan, normalizeSpan },
    })

    exporter = new Exporter(config)
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('export', () => {
    it('should buffer traces and not publish immediately when flushInterval > 0', () => {
      exporter.export([span])

      sinon.assert.notCalled(traceChannel.publish)
    })

    it('should flush immediately when flushInterval is 0', () => {
      exporter = new Exporter({ flushInterval: 0 })
      exporter.export([span])

      sinon.assert.calledOnce(traceChannel.publish)
    })

    it('should not set a second timer when called multiple times before flush', () => {
      const setTimeoutSpy = sinon.spy(global, 'setTimeout')

      exporter.export([span])
      exporter.export([span])

      sinon.assert.calledOnce(setTimeoutSpy)
    })
  })

  describe('flush', () => {
    it('should publish all buffered traces', () => {
      exporter.export([span])
      exporter.export([span])
      exporter.flush()

      sinon.assert.calledOnce(traceChannel.publish)
      const [[traces]] = traceChannel.publish.args
      sinon.assert.match(traces.length, 2)
    })

    it('should not publish when there are no buffered traces', () => {
      exporter.flush()

      sinon.assert.notCalled(traceChannel.publish)
    })

    it('should not publish when there are no subscribers', () => {
      traceChannel.hasSubscribers = false

      exporter.export([span])
      exporter.flush()

      sinon.assert.notCalled(traceChannel.publish)
    })

    it('should normalize and truncate each span', () => {
      exporter.export([span])
      exporter.flush()

      sinon.assert.calledWith(truncateSpan, span)
      sinon.assert.calledWith(normalizeSpan, span)
    })

    it('should clear the buffer after flushing', () => {
      exporter.export([span])
      exporter.flush()
      exporter.flush()

      sinon.assert.calledOnce(traceChannel.publish)
    })

    it('should call the done callback', (done) => {
      exporter.export([span])
      exporter.flush(done)
    })

    it('should publish each export call as a separate trace', () => {
      const span2 = { name: 'other', service: 'svc', meta: {}, metrics: {} }

      exporter.export([span])
      exporter.export([span2])
      exporter.flush()

      const [[traces]] = traceChannel.publish.args
      sinon.assert.match(traces[0], [span])
      sinon.assert.match(traces[1], [span2])
    })
  })
})
