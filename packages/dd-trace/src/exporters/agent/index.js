'use strict'

const { URL } = require('url')
const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const { flushWriter, trackDelivery } = require('../common/flush')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #serverlessDeliveryTracker

  constructor (config, prioritySampler) {
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()
    this._config = config
    const { lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
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
      headers,
      onFlush: (flush, done) => trackDelivery(this.#serverlessDeliveryTracker, flush, done),
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
      flushWriter(this._writer, this.#serverlessDeliveryTracker)
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        flushWriter(this._writer, this.#serverlessDeliveryTracker)
        this.#timer = undefined
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  flush (done) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (!this.#serverlessDeliveryTracker) {
      try {
        return flushWriter(this._writer, this.#serverlessDeliveryTracker, done)
      } catch (error) {
        log.error('Failed to flush traces: %s', error.message)
        done?.()
        return
      }
    }

    try {
      flushWriter(this._writer, this.#serverlessDeliveryTracker)
    } catch (error) {
      log.error('Failed to flush traces: %s', error.message)
    }
    this.#serverlessDeliveryTracker.waitForIdle(done)
  }
}

module.exports = AgentExporter
