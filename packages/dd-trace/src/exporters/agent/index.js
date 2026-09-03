'use strict'

const { URL } = require('url')
const getFlushError = require('../../flush-error')
const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #serverlessDeliveryTracker

  constructor (config, prioritySampler) {
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()
    this._config = config
    const { lookup, protocolVersion, stats = {}, apmTracingEnabled, flushInterval } = config
    this._url = config.url

    const headers = {}
    if (stats.DD_TRACE_STATS_COMPUTATION_ENABLED || apmTracingEnabled === false) {
      headers['Datadog-Client-Computed-Stats'] = 'yes'
    }

    this._writer = new Writer({
      url: this._url,
      prioritySampler,
      lookup,
      protocolVersion,
      flushInterval,
      headers,
      deliveryTracker: this.#serverlessDeliveryTracker,
    })

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.flush.bind(this))
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
  }

  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this._writer.flush()
        this.#timer = undefined
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  /**
   * @param {(error?: Error) => void} [done]
   * @param {{ reportErrors?: boolean }} [options]
   */
  flush (done, options) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (!this.#serverlessDeliveryTracker) {
      try {
        return this._writer.flush(done, options)
      } catch (error) {
        log.error('Failed to flush traces: %s', error.message)
        done?.(options?.reportErrors ? error : undefined)
        return
      }
    }

    let boundaryError
    let waiting = false
    const captureError = error => {
      if (!waiting) boundaryError = error
    }
    try {
      this._writer.flush(captureError, options)
    } catch (error) {
      log.error('Failed to flush traces: %s', error.message)
      boundaryError = error
    }
    waiting = true
    if (!done) return

    this.#serverlessDeliveryTracker.waitForIdle(error => {
      if (!options?.reportErrors || !boundaryError) return done(error)
      done(getFlushError(error ? [boundaryError, error] : [boundaryError]))
    }, options)
  }
}

module.exports = AgentExporter
