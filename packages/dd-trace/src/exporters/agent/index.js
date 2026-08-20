'use strict'

const { URL } = require('url')
const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
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
      onFlush: this.#trackWriterFlush.bind(this),
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
      this.#flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#flush()
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
        return this.#flush(done)
      } catch (error) {
        log.error('Failed to flush traces: %s', error.message)
        done?.()
        return
      }
    }

    try {
      this.#flush()
    } catch (error) {
      log.error('Failed to flush traces: %s', error.message)
    }
    this.#serverlessDeliveryTracker.waitForIdle(done)
  }

  #flush (done) {
    const flush = this._writer.flushDirect ?? this._writer.flush
    if (this.#serverlessDeliveryTracker) {
      return this.#serverlessDeliveryTracker.track(flush.bind(this._writer), done)
    }
    flush.call(this._writer, done)
  }

  #trackWriterFlush (flush, done) {
    if (this.#serverlessDeliveryTracker) return this.#serverlessDeliveryTracker.track(flush, done)
    flush(done)
  }
}

module.exports = AgentExporter
