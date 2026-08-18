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

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    // Snapshot before the boundary flush so a failed encoding cannot cause a
    // Vercel lifecycle flush to abandon exports that were already in flight.
    let activeFlushes = [...this.#activeFlushes]
    try {
      this.#flush()
    } catch (error) {
      log.error('Failed to flush traces: %s', error.message)
    }
    activeFlushes = [...new Set([...activeFlushes, ...this.#activeFlushes])]
    if (activeFlushes.length === 0) return done()

    let pending = activeFlushes.length
    const complete = () => {
      if (--pending === 0) done()
    }
    for (const flush of activeFlushes) flush.callbacks.push(complete)
  }

  #flush (done) {
    const flush = { callbacks: done ? [done] : [] }
    this.#activeFlushes.add(flush)
    const complete = () => {
      this.#activeFlushes.delete(flush)
      for (const callback of flush.callbacks) callback()
    }
    try {
      const flush = this._writer.flushDirect ?? this._writer.flush
      flush.call(this._writer, complete)
    } catch (error) {
      complete()
      throw error
    }
  }

  #trackWriterFlush (flush, done) {
    const activeFlush = { callbacks: done ? [done] : [] }
    this.#activeFlushes.add(activeFlush)
    const complete = () => {
      this.#activeFlushes.delete(activeFlush)
      for (const callback of activeFlush.callbacks) callback()
    }
    try {
      flush(complete)
    } catch (error) {
      complete()
      throw error
    }
  }
}

module.exports = AgentExporter
