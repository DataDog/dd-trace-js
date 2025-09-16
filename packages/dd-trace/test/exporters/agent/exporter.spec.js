'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
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
    url = 'http://www.example.com'
    flushInterval = 1000
    span = {}
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }
    prioritySampler = {}
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../../../src/exporters/agent', {
      './writer': Writer
    })
  })

  it('should pass computed stats header through to writer', () => {
    const stats = { enabled: true }
    exporter = new Exporter({ url, flushInterval, stats }, prioritySampler)
    expect(Writer).to.have.been.calledWithMatch({
      headers: {
        'Datadog-Client-Computed-Stats': 'yes'
      }
    })
  })

  it('should pass computed stats header through to writer if APM Tracing is disabled', () => {
    const stats = { enabled: false }
    const apmTracingEnabled = false
    exporter = new Exporter({ url, flushInterval, stats, apmTracingEnabled }, prioritySampler)

    expect(Writer).to.have.been.calledWithMatch({
      headers: {
        'Datadog-Client-Computed-Stats': 'yes'
      }
    })
  })

  it('should support IPv6', () => {
    const stats = { enabled: true }
    exporter = new Exporter({ url: 'http://[::1]', flushInterval, stats }, prioritySampler)
    expect(Writer).to.have.been.calledWithMatch({
      url: 'http://[::1]'
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    it('should not flush if export has not been called', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      setTimeout(() => {
        expect(writer.flush).not.to.have.been.called
        done()
      }, flushInterval + 100)
    })

    it('should flush after the configured interval if a payload has been exported', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      exporter.export([{}])
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
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

        expect(writer.append).to.have.been.calledWith([span])
      })
    })
  })

  describe('when interval is set to 0', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval: 0 })
    })

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      expect(writer.flush).to.have.been.called
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      exporter = new Exporter({ url })
    })

    it('should set the URL on self and writer', () => {
      const url = 'http://example2.com'
      exporter.setUrl(url)
      expect(exporter._url).to.equal(url)
      expect(writer.setUrl).to.have.been.calledWith(url)
    })
  })
})
