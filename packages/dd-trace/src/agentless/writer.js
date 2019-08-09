'use strict'

const log = require('../log')
const format = require('../format')

const MAX_SIZE = 255 * 1024 // 255kb

class LogWriter {
  constructor (prioritySampler, outputStream) {
    this._queue = []
    this._prioritySampler = prioritySampler
    this._outputStream = outputStream
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

      const formattedTrace = trace.finished.map(
        (span) => JSON.stringify(format(span))
      )

      this._erase(trace)

      if (spanContext._traceFlags.sampled === false) {
        log.debug(() => `Dropping trace due to user configured filtering: ${JSON.stringify(formattedTrace)}`)
        return
      }

      log.debug(() => `Adding trace to queue: ${JSON.stringify(formattedTrace)}`)

      for (const spanStr of formattedTrace) {
        if (spanStr.length > MAX_SIZE) {
          log.debug(() => 'Span too large to send to logs, dropping')
          continue
        }
        if (spanStr.length + this._size + 1 > MAX_SIZE) {
          this.flush()
        }
        this._size += spanStr.length + 1 // includes length of ',' character
        this._queue.push(spanStr)
      }
    }
  }

  flush () {
    if (this._queue.length > 0) {
      let logLine = '{"datadog_traces":['
      let firstTrace = true
      for (const spanStr of this._queue) {
        if (firstTrace) {
          firstTrace = false
          logLine += spanStr
        } else {
          logLine += ',' + spanStr
        }
      }
      logLine += ']}\n'
      this._outputStream.write(logLine)
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

module.exports = LogWriter
