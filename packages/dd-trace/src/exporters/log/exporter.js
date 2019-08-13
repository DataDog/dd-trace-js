'use strict'

const log = require('../../log')
const format = require('../../format')

const MAX_SIZE = 255 * 1024 // 255kb

class LogExporter {
  constructor (outputStream, maxSize = MAX_SIZE) {
    this._outputStream = outputStream
    this._maxSize = maxSize
  }

  export (span) {
    const spanContext = span.context()
    const trace = spanContext._trace

    log.debug(() => `Adding trace to queue: ${JSON.stringify(trace)}`)

    let size = 0
    let queue = []

    for (const span of trace.finished) {
      const spanStr = JSON.stringify(format(span))
      if (spanStr.length > this._maxSize) {
        log.debug('Span too large to send to logs, dropping')
        continue
      }
      if (spanStr.length + size + 1 > this._maxSize) {
        this._printSpans(queue)
        queue = []
        size = 0
      }
      size += spanStr.length + 1 // includes length of ',' character
      queue.push(spanStr)
    }
    if (queue.length > 0) {
      this._printSpans(queue)
    }
  }

  _printSpans (queue) {
    let logLine = '{"datadog_traces":['
    let firstTrace = true
    for (const spanStr of queue) {
      if (firstTrace) {
        firstTrace = false
        logLine += spanStr
      } else {
        logLine += ',' + spanStr
      }
    }
    logLine += ']}\n'
    this._outputStream.write(logLine)
  }
}

module.exports = LogExporter
