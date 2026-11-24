'use strict'

const { lookup } = require('node:dns')

const { DogStatsDClient } = require('../../../dd-trace/src/dogstatsd')

const TAG_RE = /[^\w:/.-]/gu

class LambdaDogStatsD {
  static #resolvedFlush = Promise.resolve()
  #client
  #flushPromise

  constructor () {
    this.#client = new DogStatsDClient({
      host: '127.0.0.1',
      port: 8125,
      tags: [],
      lookup,
      includeEntityId: false,
      flushTimeoutMs: 1000,
    })
  }

  /**
   * @param {string} metric
   * @param {number} value
   * @param {number} [timestamp] Seconds since epoch.
   * @param {string[]} [tags]
   */
  distribution (metric, value, timestamp, tags) {
    if (value == null) return
    if (timestamp) timestamp = Math.floor(timestamp)
    this.#client.distribution(metric, value, tags?.map(tag => tag.replaceAll(TAG_RE, '_')), timestamp)
    this.#client.flush()
  }

  /** @returns {Promise<void>} */
  flush () {
    if (this.#flushPromise) return this.#flushPromise
    let completed = false
    let finish
    this.#client.flush(() => {
      completed = true
      this.#flushPromise = undefined
      finish?.()
    })
    if (completed) return LambdaDogStatsD.#resolvedFlush
    this.#flushPromise = new Promise(resolve => { finish = resolve })
    return this.#flushPromise
  }
}

module.exports = { LambdaDogStatsD }
