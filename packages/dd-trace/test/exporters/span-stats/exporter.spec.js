'use strict'

require('../../setup/tap')

const { expect } = require('chai')

const URL = require('url').URL

describe('span-stats exporter', () => {
  let url
  let Exporter
  let exporter
  let Writer
  let writer

  beforeEach(() => {
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

  it('should flush immediately on export', () => {
    exporter = new Exporter({ url })

    expect(writer.append).to.have.not.been.called
    expect(writer.flush).to.have.not.been.called

    exporter.export('')

    expect(writer.append).to.have.been.called
    expect(writer.flush).to.have.been.called
  })

  it('should set url from hostname and port', () => {
    const hostname = '0.0.0.0'
    const port = '1234'
    const url = new URL(`http://${hostname}:${port}`)

    exporter = new Exporter({ hostname, port })

    expect(exporter._url).to.be.deep.equal(url)
    expect(Writer).to.have.been.calledWith({
      url: exporter._url,
      tags: undefined
    })
  })

  it('should pass tags through to writer', () => {
    const tags = { foo: 'bar' }

    exporter = new Exporter({ url, tags })

    expect(Writer).to.have.been.calledWith({
      url: exporter._url,
      tags
    })
  })
})
