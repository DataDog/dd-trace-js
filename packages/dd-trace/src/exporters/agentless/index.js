'use strict'

const { URL } = require('node:url')

const log = require('../../log')
const Writer = require('./writer')

/**
 * Agentless exporter for APM span intake.
 * Sends spans directly to the Datadog intake without requiring a local agent.
 */
class AgentlessExporter {
  #timer

  /**
   * @param {object} config - Configuration object
   */
  constructor (config) {
    this._config = config
    const { site = 'datadoghq.com', url } = config

    this._url = url ? new URL(url) : new URL(`https://public-trace-http-intake.logs.${site}`)

    this._writer = new Writer({
      url: this._url,
      site,
    })

    const ddTrace = globalThis[Symbol.for('dd-trace')]
    if (ddTrace?.beforeExitHandlers) {
      ddTrace.beforeExitHandlers.add(this.flush.bind(this))
    } else {
      log.error(
        'dd-trace global not properly initialized. ' +
        'beforeExit handler not registered for agentless exporter.'
      )
    }
  }

  /**
   * Sets the intake URL.
   * @param {string} urlString - The new intake URL
   */
  setUrl (urlString) {
    try {
      const url = new URL(urlString)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.error(
        'Invalid URL provided to agentless exporter: %s. ' +
        'URL must be a valid absolute URL (e.g., https://intake.example.com). ' +
        'Continuing to use previous URL: %s',
        urlString,
        this._url?.href || 'none'
      )
    }
  }

  /**
   * Exports spans to the intake.
   * @param {object[]} spans - Array of formatted spans
   */
  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this._writer.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  /**
   * Flushes all pending spans.
   * @param {function} [done] - Callback when flush is complete
   */
  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this._writer.flush(done)
  }
}

module.exports = AgentlessExporter
