'use strict'

const { URL } = require('node:url')
const os = require('node:os')

const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const TelemetryDeliveryTracker = require('../../serverless/telemetry-delivery-tracker')
const { containerId } = require('../common/docker')
const Writer = require('./writer')
const { computeIntakeUrl } = require('./intake')

/**
 * Agentless exporter for APM trace intake.
 * Sends traces directly to the Datadog intake without requiring a local agent.
 * Batches multiple traces per request using timer-based flushing.
 */
class AgentlessExporter {
  #deliveryTracker
  #timer
  #config

  /**
   * @param {object} config - Configuration object
   * @param {string} [config.site] - The Datadog site. Defaults to 'datadoghq.com'.
   * @param {number} [config.flushInterval] - Batch flush interval in ms
   * @param {string} [config.env] - Environment name
   * @param {object} config.tags - Tags including runtime-id
   */
  constructor (config) {
    this.#deliveryTracker = createServerlessDeliveryTracker()
    if (!this.#deliveryTracker && TelemetryDeliveryTracker.isProcessTrackingEnabled()) {
      this.#deliveryTracker = new TelemetryDeliveryTracker()
    }
    this.#config = config
    const site = config.site ?? 'datadoghq.com'

    try {
      // Agentless traffic carries the Datadog API key, so the intake is always an https endpoint
      // derived from the site; never config.url (the agent's cleartext http) or the key leaks.
      this._url = new URL(computeIntakeUrl(site))
    } catch (err) {
      log.error('Invalid site for agentless exporter. site=%s. Error: %s', site, err.message)
      this._url = null
    }

    const metadata = {
      hostname: os.hostname(),
      // Read live off `config` (instead of copying the value) so a later change
      // (e.g. a MicroVM clone resume) is picked up by the next data-pipeline export.
      get env () { return config.env },
      get runtimeID () { return config.tags['runtime-id'] },
    }
    if (containerId) metadata.containerId = containerId

    this._writer = new Writer({
      url: this._url,
      site,
      metadata,
      deliveryTracker: this.#deliveryTracker,
    })

    const ddTrace = globalThis[Symbol.for('dd-trace')]
    if (ddTrace?.beforeExitHandlers) {
      ddTrace.beforeExitHandlers.add(this.flush.bind(this))
    } else {
      log.error('dd-trace global not properly initialized. beforeExit handler not registered for agentless exporter.')
    }
  }

  enableDeliveryTracking () {
    if (this.#deliveryTracker) return

    this.#deliveryTracker = new TelemetryDeliveryTracker()
    this._writer.enableDeliveryTracking(this.#deliveryTracker)
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

    const { flushInterval } = this.#config

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
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  /**
   * Flushes any pending traces immediately. Clears the batch timer.
   * @param {(error?: Error) => void} [done] - Callback when flush is complete
   * @param {{ reportErrors?: boolean }} [options]
   */
  flush (done, options) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (!this.#deliveryTracker) {
      try {
        this._writer.flush(done, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to flush traces: %s', message)
        done?.(options?.reportErrors ? (error instanceof Error ? error : new Error(message)) : undefined)
      }
      return
    }

    let boundaryError
    let waiting = false
    const captureError = error => {
      if (!waiting) boundaryError = error
    }
    try {
      this._writer.flush(captureError, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to flush traces: %s', message)
      boundaryError = error instanceof Error ? error : new Error(message)
    }
    waiting = true
    if (!done) return

    this.#deliveryTracker.waitForIdle(() => {
      done(options?.reportErrors ? boundaryError : undefined)
    })
  }
}

module.exports = AgentlessExporter
