'use strict'

const { URL } = require('node:url')
const os = require('node:os')

const log = require('../../log')
const { entityId } = require('../common/docker')
const tracerVersion = require('../../../../../package.json').version
const Writer = require('./writer')

/**
 * Agentless exporter for APM trace intake.
 * Sends traces directly to the Datadog intake without requiring a local agent.
 * Batches multiple traces per request using timer-based flushing.
 */
class AgentlessExporter {
  #timer

  /**
   * @param {object} config - Configuration object
   * @param {string} [config.site='datadoghq.com'] - The Datadog site
   * @param {string} [config.url] - Override intake URL
   * @param {number} [config.flushInterval] - Batch flush interval in ms
   * @param {string} [config.env] - Environment name
   * @param {object} [config.tags] - Tags including runtime-id
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

    const metadata = {
      hostname: os.hostname(),
      env: config.env,
      languageName: 'nodejs',
      languageVersion: process.version,
      tracerVersion,
      runtimeID: config.tags?.['runtime-id'],
      ...(entityId ? { containerID: entityId } : {}),
    }

    this._writer = new Writer({
      url: this._url,
      site,
      metadata,
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
    } catch (err) {
      log.error(
        'Invalid URL for agentless exporter: %s. Using previous URL: %s. Error: %s',
        urlString,
        this._url?.href || 'none',
        err.message
      )
      return false
    }
  }

  /**
   * Exports a trace. Traces are batched and flushed on a timer.
   * @param {object[]} spans - Array of spans (all from the same trace)
   */
  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      try {
        this._writer.flush()
      } catch (err) {
        log.error('Failed to flush traces: %s', err.message)
      }
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        try {
          this._writer.flush()
        } catch (err) {
          log.error('Failed to flush traces on timer: %s', err.message)
        }
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  /**
   * Flushes any pending traces immediately. Clears the batch timer.
   * @param {Function} [done] - Callback when flush is complete
   */
  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    try {
      this._writer.flush(done)
    } catch (err) {
      log.error('Failed to flush traces: %s', err.message)
      done()
    }
  }
}

module.exports = AgentlessExporter
