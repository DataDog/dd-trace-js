'use strict'

const t = require('tap')
require('../../setup/core')

const { expect } = require('chai')

const URL = require('url').URL

t.test('Exporter', t => {
  let url
  let flushInterval
  let Exporter
  let exporter
  let Writer
  let writer
  let prioritySampler
  let span

  t.beforeEach(() => {
    url = 'www.example.com'
    flushInterval = 1000
    span = {}
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }
    prioritySampler = {}
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../src/exporters/agent', {
      './writer': Writer
    })
  })

  t.test('should pass computed stats header through to writer', t => {
    const stats = { enabled: true }
    exporter = new Exporter({ url, flushInterval, stats }, prioritySampler)
    expect(Writer).to.have.been.calledWithMatch({
      headers: {
        'Datadog-Client-Computed-Stats': 'yes'
      }
    })
    t.end()
  })

  t.test('should pass computed stats header through to writer if APM Tracing is disabled', t => {
    const stats = { enabled: false }
    const apmTracingEnabled = false
    exporter = new Exporter({ url, flushInterval, stats, apmTracingEnabled }, prioritySampler)

    expect(Writer).to.have.been.calledWithMatch({
      headers: {
        'Datadog-Client-Computed-Stats': 'yes'
      }
    })
    t.end()
  })

  t.test('should support IPv6', t => {
    const stats = { enabled: true }
    exporter = new Exporter({ hostname: '::1', flushInterval, stats }, prioritySampler)
    expect(Writer).to.have.been.calledWithMatch({
      url: new URL('http://[::1]')
    })
    t.end()
  })

  t.test('when interval is set to a positive number', t => {
    t.beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    t.test('should not flush if export has not been called', (t) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      setTimeout(() => {
        expect(writer.flush).not.to.have.been.called
        t.end()
      }, flushInterval + 100)
    })

    t.test('should flush after the configured interval if a payload has been exported', (t) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      exporter.export([{}])
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        t.end()
      }, flushInterval + 100)
    })

    t.test('export', t => {
      t.beforeEach(() => {
        span = {}
      })

      t.test('should export a span', t => {
        writer.length = 0
        exporter.export([span])

        expect(writer.append).to.have.been.calledWith([span])
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('when interval is set to 0', t => {
    t.beforeEach(() => {
      exporter = new Exporter({ url, flushInterval: 0 })
    })

    t.test('should flush right away when interval is set to 0', t => {
      exporter.export([span])
      expect(writer.flush).to.have.been.called
      t.end()
    })
    t.end()
  })

  t.test('setUrl', t => {
    t.beforeEach(() => {
      exporter = new Exporter({ url })
    })

    t.test('should set the URL on self and writer', t => {
      exporter.setUrl('http://example2.com')
      const url = new URL('http://example2.com')
      expect(exporter._url).to.deep.equal(url)
      expect(writer.setUrl).to.have.been.calledWith(url)
      t.end()
    })
    t.end()
  })
  t.end()
})
