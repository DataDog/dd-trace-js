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

  flush (done = () => {}) {
    this.#flush()

    const activeFlushes = [...this.#activeFlushes]
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
    this._writer.flush(() => {
      this.#activeFlushes.delete(flush)
      for (const callback of flush.callbacks) callback()
    })
  }
}

module.exports = {
  SpanStatsExporter,
}
