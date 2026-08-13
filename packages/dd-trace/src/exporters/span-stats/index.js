'use strict'

const { Writer } = require('./writer')

class SpanStatsExporter {
  #activeFlushes = new Set()

  constructor (config) {
    this._url = config.url
    this._writer = new Writer({ url: this._url })
  }

  export (payload, done) {
    this._writer.append(payload)
    this.#flush(done)
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
      this._writer.flush(complete)
    } catch (error) {
      complete()
      throw error
    }
  }
}

module.exports = {
  SpanStatsExporter,
}
