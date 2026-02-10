'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach } = require('mocha')
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
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../../../src/exporters/agent', {
      './writer': Writer,
    })
  })

  it('should pass computed stats header through to writer', () => {
    const stats = { enabled: true }
    exporter = new Exporter({ url, flushInterval, stats }, prioritySampler)
    sinon.assert.calledWithMatch(Writer, {
      headers: {
        'Datadog-Client-Computed-Stats': 'yes',
      },
    })
  })

  it('should pass computed stats header through to writer if APM Tracing is disabled', () => {
    const stats = { enabled: false }
    const apmTracingEnabled = false
    exporter = new Exporter({ url, flushInterval, stats, apmTracingEnabled }, prioritySampler)

    sinon.assert.calledWithMatch(Writer, {
      headers: {
        'Datadog-Client-Computed-Stats': 'yes',
      },
    })
  })

  it('should support IPv6', () => {
    const stats = { enabled: true }
    exporter = new Exporter({ hostname: '::1', flushInterval, stats }, prioritySampler)
    sinon.assert.calledWithMatch(Writer, {
      url: new URL('http://[::1]:8126/'),
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
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

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      sinon.assert.called(writer.flush)
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
