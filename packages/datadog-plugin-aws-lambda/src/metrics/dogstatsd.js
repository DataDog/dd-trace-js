'use strict'

const dgram = require('node:dgram')

const log = require('../../../dd-trace/src/log')

const TAG_RE = /[^\w:/.-]/gu

// Core DogStatsD aggregates distributions and has no per-point timestamp/awaited-send contract.
// Keep the Lambda extension's one-point packets private rather than changing the public tracer client.
class LambdaDogStatsD {
  static #resolvedFlush = Promise.resolve()
  #socket
  #pendingSends = 0
  #generation = 0
  #flushPromise
  #resolveFlush
  #flushTimeout

  constructor () {
    this.#socket = dgram.createSocket('udp4')
    this.#socket.unref?.()
    // A socket error event must not terminate the application. Pending callbacks/flush timeout still settle sends.
    this.#socket.on('error', error => log.debug('Unable to send metric packet: %s', error.message))
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
    let serializedTags = ''
    if (tags?.length) {
      let separator = '|#'
      for (const tag of tags) {
        serializedTags += separator + tag.replaceAll(TAG_RE, '_')
        separator = ','
      }
    }
    const timestampPart = timestamp == null ? '' : `|T${timestamp}`
    const message = Buffer.from(`${metric}:${value}|d${serializedTags}${timestampPart}`, 'utf8')
    const generation = this.#generation
    this.#pendingSends++
    try {
      this.#socket.send(message, 8125, '127.0.0.1', error => this.#completeSend(generation, error))
    } catch (error) {
      this.#completeSend(generation, error instanceof Error ? error : new Error('Unknown socket send failure'))
    }
  }

  /**
   * @param {number} generation
   * @param {Error|null} [error]
   */
  #completeSend (generation, error) {
    if (error) log.debug('Unable to send metric packet: %s', error.message)
    if (generation !== this.#generation) return
    this.#pendingSends--
    if (this.#pendingSends === 0 && this.#resolveFlush !== undefined) this.#finishFlush(false)
  }

  /** @param {boolean} timedOut */
  #finishFlush (timedOut) {
    const resolve = this.#resolveFlush
    if (this.#flushTimeout !== undefined) clearTimeout(this.#flushTimeout)
    this.#flushPromise = undefined
    this.#resolveFlush = undefined
    this.#flushTimeout = undefined
    if (timedOut) {
      this.#pendingSends = 0
      this.#generation++
      log.debug('Timed out before sending all metric payloads')
    }
    resolve()
  }

  /** @returns {Promise<void>} */
  flush () {
    if (this.#pendingSends === 0) return LambdaDogStatsD.#resolvedFlush
    if (this.#flushPromise !== undefined) return this.#flushPromise
    this.#flushPromise = new Promise(resolve => { this.#resolveFlush = resolve })
    this.#flushTimeout = setTimeout(() => this.#finishFlush(true), 1000)
    return this.#flushPromise
  }
}

module.exports = { LambdaDogStatsD }
