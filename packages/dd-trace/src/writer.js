'use strict'

const log = require('./log')
const format = require('./format')
const encode = require('./encode')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

class Writer {
  constructor (prioritySampler, exporters) {
    this._queue = []
    this._prioritySampler = prioritySampler
    this._exporters = exporters
    this._size = 0
  }

  get length () {
    return this._queue.length
  }

  append (span) {
    const spanContext = span.context()
    const trace = spanContext._trace

    if (trace.started.length === trace.finished.length) {
      this._prioritySampler.sample(spanContext)

      const formattedTrace = trace.finished.map(format)

      this._erase(trace)

      if (spanContext._traceFlags.sampled === false) {
        log.debug(() => `Dropping trace due to user configured filtering: ${JSON.stringify(formattedTrace)}`)
        return
      }

      log.debug(() => `Encoding trace: ${JSON.stringify(formattedTrace)}`)

      const buffer = encode(formattedTrace)

      log.debug(() => `Adding encoded trace to buffer: ${buffer.toString('hex').match(/../g).join(' ')}`)

      if (buffer.length + this._size > MAX_SIZE) {
        this.flush()
      }

      this._size += buffer.length
      this._queue.push(buffer)
    }
  }

  flush () {
    if (this._queue.length > 0) {
      for (const exporter of this._exporters) {
        exporter.send(this._queue)
      }

      this._queue = []
      this._size = 0
    }
  }

  _erase (trace) {
    trace.finished.forEach(span => {
      span.context()._tags = {}
      span.context()._metrics = {}
    })

    trace.started = []
    trace.finished = []
  }
}

module.exports = Writer
