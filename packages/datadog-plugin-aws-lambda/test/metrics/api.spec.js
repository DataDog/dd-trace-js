'use strict'

const assert = require('node:assert/strict')
const { stringify } = require('node:querystring')
const { deflateSync } = require('node:zlib')

const { afterEach, describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

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

  it('uses shared HTTP delivery with source completion/timeout and processor-owned retries', async () => {
    const request = sinon.stub().callsFake((body, options, callback) => callback(null, '', 202))
    const Client = proxyquire('../../src/metrics/api', {
      '../../../dd-trace/src/exporters/common/request': request,
    }).APIClient
    await new Client('key', baseUrl).sendMetrics(metrics)
    sinon.assert.calledOnceWithExactly(request, deflateSync(Buffer.from(JSON.stringify({ series: metrics }))), {
      url: `${baseUrl}/api/v1/distribution_points?api_key=key`,
      method: 'POST',
      headers: { 'Content-Encoding': 'deflate' },
      timeout: false,
      responseType: 'none',
      retry: false,
      keepProcessAlive: true,
    }, sinon.match.func)
  })
})
