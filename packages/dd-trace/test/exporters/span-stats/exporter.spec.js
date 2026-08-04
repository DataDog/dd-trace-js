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

  beforeEach(() => {
    url = new URL('http://www.example.com:8126')
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
    }
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../../../src/exporters/span-stats', {
      './writer': { Writer },
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

  it('should set url from config', () => {
    const url = new URL('http://0.0.0.0:1234')

    exporter = new Exporter({ url })

    assert.strictEqual(exporter._url.toString(), url.toString())
    sinon.assert.calledWith(Writer, {
      url: exporter._url,
    })
  })
})
