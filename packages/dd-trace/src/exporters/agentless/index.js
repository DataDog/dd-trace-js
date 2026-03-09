'use strict'

const { URL } = require('node:url')

const log = require('../../log')
const Writer = require('./writer')

/**
 * Agentless exporter for APM trace intake.
 * Sends traces directly to the Datadog intake without requiring a local agent.
 *
 * Traces are buffered in the encoder and batched into a single payload
 * using the {"traces": [[...], ...]} format when flushed.
 */
class AgentlessExporter {
  #timer

  /**
   * @param {object} config - Configuration object
   * @param {string} [config.site='datadoghq.com'] - The Datadog site
   * @param {string} [config.url] - Override intake URL
   * @param {number} [config.flushInterval] - Flush interval in ms (0 = flush immediately)
   */
  constructor (config) {
    this._config = config
    const { site = 'datadoghq.com', url } = config

    try {
      this._url = url ? new URL(url) : new URL(`https://public-trace-http-intake.logs.${site}`)
    } catch (err) {
      log.error(
        'Invalid URL configuration for agentless exporter. url=%s, site=%s. Error: %s',
        url || 'not set',
        site,
        err.message
      )
      this._url = null
    }

    this._writer = new Writer({
      url: this._url,
      site,
    })

    const ddTrace = globalThis[Symbol.for('dd-trace')]
    if (ddTrace?.beforeExitHandlers) {
      ddTrace.beforeExitHandlers.add(this.flush.bind(this))
    } else {
      log.error('dd-trace global not properly initialized. beforeExit handler not registered for agentless exporter.')
    }
  }

  /**
   * Sets the intake URL.
   * @param {string} urlString - The new intake URL
   * @returns {boolean} True if URL was set successfully
   */
  setUrl (urlString) {
    try {
      const url = new URL(urlString)
      this._url = url
      this._writer.setUrl(url)
      return true
    } catch {
      log.error('Invalid URL for agentless exporter: %s. Using previous URL: %s', urlString, this._url?.href || 'none')
      return false
    }
  }

  /**
   * Buffers a trace and schedules a flush based on the configured interval.
   * @param {object[]} spans - Array of spans (all from the same trace)
   */
  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0 || this._writer.isFull()) {
      clearTimeout(this.#timer)
      this.#timer = undefined
      this._writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this._writer.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  /**
   * Flushes all buffered traces as a single batched payload.
   * @param {Function} [done] - Callback when flush is complete
   */
  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this._writer.flush(done)
  }
}

module.exports = AgentlessExporter
