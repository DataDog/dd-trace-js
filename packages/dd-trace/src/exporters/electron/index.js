'use strict'

const { channel } = require('dc-polyfill')
const { truncateSpan, normalizeSpan } = require('../../encode/tags-processors')

const traceChannel = channel('datadog:apm:electron:export')

class ElectronExporter {
  #timer
  #traces = []

  constructor (config) {
    this._config = config

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.flush.bind(this))
  }

  export (spans) {
    this.#traces.push(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.flush()
        this.#timer = undefined
      }, flushInterval).unref?.()
    }
  }

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    const traces = this.#traces.splice(0)

    if (traces.length > 0 && traceChannel.hasSubscribers) {
      const formattedTraces = traces.map(spans => spans.map(span => normalizeSpan(truncateSpan(span))))
      traceChannel.publish(formattedTraces)
    }

    done()
  }
}

module.exports = ElectronExporter
