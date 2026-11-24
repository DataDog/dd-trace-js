'use strict'

const http = require('node:http')
const https = require('node:https')
const { stringify } = require('node:querystring')
const { deflateSync } = require('node:zlib')

const { storage } = require('../../../datadog-core')
const log = require('../../../dd-trace/src/log')

const legacyStorage = storage('legacy')

class APIClient {
  #key
  #baseUrl

  /**
   * @param {string} key
   * @param {string} baseUrl
   */
  constructor (key, baseUrl) {
    this.#key = key
    this.#baseUrl = baseUrl
  }

  /** @param {import('./model').APIMetric[]} metrics */
  async sendMetrics (metrics) {
    const url = new URL('api/v1/distribution_points', this.#baseUrl)
    url.search = stringify({ api_key: this.#key })
    const body = deflateSync(Buffer.from(JSON.stringify({ series: metrics })))
    // Core's request helper imposes a timeout and waits for the response body. Preserve the shim's
    // header-completion contract and let the processor own retries, without tracing intake traffic.
    await new Promise((resolve, reject) => legacyStorage.run({ noop: true }, () => {
      const client = url.protocol === 'https:' ? https : http
      const req = client.request({
        host: url.host,
        hostname: url.hostname,
        port: url.port,
        protocol: url.protocol,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Encoding': 'deflate' },
      }, response => {
        response.once('error', error => log.debug('Unable to read Lambda metric response: %s', error.message))
        response.resume()
        const status = response.statusCode
        if (status === undefined || status < 200 || status > 299) {
          // Never include the URL: the source protocol puts the API key in the query string.
          reject(new Error(`HTTP error code: ${status}`))
        } else {
          resolve()
        }
      })
      req.once('error', reject)
      req.write(body)
      req.end()
    }))
  }
}

module.exports = { APIClient }
