'use strict'

const { stringify } = require('node:querystring')
const { deflateSync } = require('node:zlib')

const request = require('../../../dd-trace/src/exporters/common/request')

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
    await new Promise((resolve, reject) => {
      request(body, {
        url: url.href,
        method: 'POST',
        headers: { 'Content-Encoding': 'deflate' },
        timeout: false,
        responseType: 'none',
        retry: false,
        keepProcessAlive: true,
      }, error => error ? reject(error) : resolve())
    })
  }
}

module.exports = { APIClient }
