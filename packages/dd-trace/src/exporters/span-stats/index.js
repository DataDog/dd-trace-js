'use strict'

const log = require('../../log')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #activeFlushes = new Set()

  constructor (config) {
    this._url = config.url
    this._writer = new Writer({ url: this._url, onFlush: this.#trackWriterFlush.bind(this) })
  }

  export (payload, done) {
    if (done) {
      const activeFlushes = [...this.#activeFlushes]
      let pending = activeFlushes.length + 1
      const complete = () => {
        if (--pending === 0) done()
      }
      for (const flush of activeFlushes) flush.callbacks.push(complete)
      this._writer.append(payload)
      try {
        this.#flush(complete)
      } catch (error) {
        // `#flush` has notified the boundary request; keep waiting for prior exports.
        log.error('Failed to flush span stats: %s', error.message)
      }
      return
    }
    this._writer.append(payload)
    this.#flush()
  }

  flush (done) {
    const activeFlushes = [...this.#activeFlushes]
    let pending = activeFlushes.length + 1
    const complete = () => {
      if (--pending === 0) done?.()
    }
    for (const flush of activeFlushes) flush.callbacks.push(complete)
    this.#flush(complete)
  }

  #flush (done) {
    const flush = { callbacks: done ? [done] : [] }
    this.#activeFlushes.add(flush)
    const complete = () => {
      this.#activeFlushes.delete(flush)
      for (const callback of flush.callbacks) callback()
    }
    try {
      const flushWriter = this._writer.flushDirect ?? this._writer.flush
      flushWriter.call(this._writer, complete)
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

module.exports = {
  SpanStatsExporter,
}
