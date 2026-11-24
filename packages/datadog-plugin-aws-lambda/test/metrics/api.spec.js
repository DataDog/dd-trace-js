'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { stringify } = require('node:querystring')
const { deflateSync } = require('node:zlib')

const { afterEach, describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

const log = require('../../../dd-trace/src/log')
const { APIClient } = require('../../src/metrics/api')

const baseUrl = 'https://www.example.com'
const metrics = ['a-metric', 'b-metric'].map(metric => ({
  metric, points: [[1, [2]], [3, [4]], [5, [6]]], tags: ['a', 'b', 'c'], type: 'distribution',
}))

function endpoint (key, series) {
  return nock(baseUrl, { reqheaders: { 'content-encoding': 'deflate' } })
    .post(`/api/v1/distribution_points?${stringify({ api_key: key })}`, deflateSync(JSON.stringify({ series })))
}

describe('Lambda metrics direct API source contracts', () => {
  afterEach(() => { nock.cleanAll(); sinon.restore() })

  for (const status of [200, 202, 204, 299]) {
    it(`sends compressed distribution series, accepting ${status}`, async () => {
      const scope = endpoint('api_key', metrics).reply(status)
      await new APIClient('api_key', baseUrl).sendMetrics(metrics)
      scope.done()
    })
  }

  for (const status of [300, 403, 500]) {
    it(`rejects ${status} once without exposing the API key`, async () => {
      const scope = endpoint('bad_api_key', []).reply(status)
      await assert.rejects(new APIClient('bad_api_key', baseUrl).sendMetrics([]), {
        message: `HTTP error code: ${status}`,
      })
      scope.done()
    })
  }

  it('preserves connection failure messages without a transport retry', async () => {
    const scope = endpoint('api_key', []).replyWithError('Connection closed')
    await assert.rejects(new APIClient('api_key', baseUrl).sendMetrics([]), { message: 'Connection closed' })
    scope.done()
  })

  it('encodes API keys using the source query-string rules', async () => {
    const scope = endpoint('a +/&?=', []).reply(200)
    await new APIClient('a +/&?=', baseUrl).sendMetrics([])
    scope.done()
  })

  it('does not impose a timeout or transport retries on the source request', async () => {
    const debug = sinon.stub(log, 'debug')
    const response = new EventEmitter()
    response.statusCode = 202
    response.resume = sinon.spy()
    const req = new EventEmitter()
    req.write = sinon.spy()
    req.end = sinon.spy()
    const request = sinon.stub().returns(req)
    const Client = proxyquire('../../src/metrics/api', { 'node:https': { request } }).APIClient
    const pending = new Client('key', baseUrl).sendMetrics(metrics)
    const [options, callback] = request.firstCall.args
    assert.strictEqual(options.timeout, undefined)
    callback(response)
    await pending
    sinon.assert.calledOnce(response.resume)
    sinon.assert.calledOnceWithExactly(req.write, deflateSync(Buffer.from(JSON.stringify({ series: metrics }))))
    sinon.assert.calledOnce(req.end)
    response.emit('error', new Error('body failed after headers'))
    sinon.assert.calledWithExactly(debug, 'Unable to read Lambda metric response: %s', 'body failed after headers')
  })
})
