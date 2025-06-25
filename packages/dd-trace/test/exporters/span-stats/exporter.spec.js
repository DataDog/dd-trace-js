'use strict'

const t = require('tap')
require('../../setup/core')

const { expect } = require('chai')

const URL = require('url').URL

t.test('span-stats exporter', t => {
  let url
  let Exporter
  let exporter
  let Writer
  let writer

  t.beforeEach(() => {
    url = 'www.example.com'
    writer = {
      append: sinon.spy(),
      flush: sinon.spy()
    }
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../src/exporters/span-stats', {
      './writer': { Writer }
    }).SpanStatsExporter
  })

  t.test('should flush immediately on export', t => {
    exporter = new Exporter({ url })

    expect(writer.append).to.have.not.been.called
    expect(writer.flush).to.have.not.been.called

    exporter.export('')

    expect(writer.append).to.have.been.called
    expect(writer.flush).to.have.been.called
    t.end()
  })

  t.test('should set url from hostname and port', t => {
    const hostname = '0.0.0.0'
    const port = '1234'
    const url = new URL(`http://${hostname}:${port}`)

    exporter = new Exporter({ hostname, port })

    expect(exporter._url).to.be.deep.equal(url)
    expect(Writer).to.have.been.calledWith({
      url: exporter._url,
      tags: undefined
    })
    t.end()
  })

  t.test('should pass tags through to writer', t => {
    const tags = { foo: 'bar' }

    exporter = new Exporter({ url, tags })

    expect(Writer).to.have.been.calledWith({
      url: exporter._url,
      tags
    })
    t.end()
  })
  t.end()
})
