'use strict'

const { URL } = require('url')
const log = require('../../log')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #destroyer

  constructor (config, prioritySampler) {
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
      trackPayloads: true,
    })

    this.#destroyer = this.flush.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.#destroyer)
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

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this._writer.flush(done)
  }

  /**
   * Moves pending traces to a replacement exporter instead of sending them through this exporter.
   *
   * @param {{ export: (spans: object[]) => void }} exporter - Exporter that should receive pending traces.
   * @returns {boolean} Whether pending trace tracking was enabled and handled.
   */
  transferPendingTo (exporter) {
    const pendingPayloads = this._writer.drain()
    if (pendingPayloads === undefined) return false

    clearTimeout(this.#timer)
    this.#timer = undefined

    for (const payload of pendingPayloads) {
      exporter.export(payload)
    }

    return true
  }

  destroy () {
    clearTimeout(this.#timer)
    this.#timer = undefined
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
  }
}

module.exports = AgentExporter
