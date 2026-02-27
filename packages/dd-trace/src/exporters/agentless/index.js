'use strict'

const { URL } = require('node:url')

const log = require('../../log')
const Writer = require('./writer')

/**
 * Agentless exporter for APM span intake.
 * Sends spans directly to the Datadog intake without requiring a local agent.
 *
 * Each trace is sent immediately as a separate request. The intake only accepts one trace
 * per request - requests with spans from different traces return HTTP 200 but silently
 * drop all spans. By flushing immediately after each export (which contains one trace),
 * we avoid this limitation entirely. -- bengl
 */
class AgentlessExporter {
  /**
   * @param {object} config - Configuration object
   * @param {string} [config.site='datadoghq.com'] - The Datadog site
   * @param {string} [config.url] - Override intake URL
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
      log.error(
        'dd-trace global not properly initialized. ' +
        'beforeExit handler not registered for agentless exporter.'
      )
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
    } catch (e) {
      log.error(
        'Invalid URL provided to agentless exporter: %s. ' +
        'URL must be a valid absolute URL (e.g., https://intake.example.com). ' +
        'Continuing to use previous URL: %s',
        urlString,
        this._url?.href || 'none'
      )
      return false
    }
  }

  /**
   * Exports a trace to the intake. Flushes immediately since each trace must be
   * sent as a separate request.
   * @param {object[]} spans - Array of spans (all from the same trace)
   */
  export (spans) {
    this._writer.append(spans)
    this._writer.flush()
  }

  /**
   * Flushes any pending spans. With immediate flush per trace, this is mainly
   * used for the beforeExit handler to ensure nothing is left unsent.
   * @param {function} [done] - Callback when flush is complete
   */
  flush (done = () => {}) {
    this._writer.flush(done)
  }
}

module.exports = AgentlessExporter
