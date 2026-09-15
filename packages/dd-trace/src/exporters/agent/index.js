'use strict'

const { URL } = require('url')
const { channel } = require('dc-polyfill')
const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const Writer = require('./writer')

const identityRefreshChannel = channel('datadog:identity:refresh')

// Only one AgentExporter is ever live in a real process, so replacing the subscription on
// construction is safe - it just keeps tests (which build several) from piling up listeners.
let unsubscribeBatchReset = null

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

    // A clone resume shouldn't flush spans buffered before the snapshot under its own identity.
    unsubscribeBatchReset?.()
    const onIdentityRefresh = () => this._writer.resetPendingBatch()
    identityRefreshChannel.subscribe(onIdentityRefresh)
    unsubscribeBatchReset = () => identityRefreshChannel.unsubscribe(onIdentityRefresh)

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

  flush (done) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (!this.#serverlessDeliveryTracker) {
      try {
        return this._writer.flush(done)
      } catch (error) {
        log.error('Failed to flush traces: %s', error.message)
        done?.()
        return
      }
    }

    try {
      this._writer.flush()
    } catch (error) {
      log.error('Failed to flush traces: %s', error.message)
    }
    this.#serverlessDeliveryTracker.waitForIdle(done)
  }
}

module.exports = AgentExporter
