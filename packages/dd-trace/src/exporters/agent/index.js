'use strict'

const { URL } = require('url')
const log = require('../../log')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #activeFlushes = new Set()

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

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#flush()

    const activeFlushes = [...this.#activeFlushes]
    if (activeFlushes.length === 0) return done()

    let pending = activeFlushes.length
    const complete = () => {
      if (--pending === 0) done()
    }
    for (const flush of activeFlushes) flush.callbacks.push(complete)
  }

  #flush () {
    const flush = { callbacks: [] }
    this.#activeFlushes.add(flush)
    this._writer.flush(() => {
      this.#activeFlushes.delete(flush)
      for (const callback of flush.callbacks) callback()
    })
  }
}

module.exports = AgentExporter
