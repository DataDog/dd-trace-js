'use strict'

const { Formatter } = require('./formatter')

const TRACE_PREFIX = '{"traces":[['
const TRACE_SUFFIX = ']]}\n'
const TRACE_FORMAT_OVERHEAD = TRACE_PREFIX.length + TRACE_SUFFIX.length
const MAX_SIZE = 64 * 1024 // 64kb

class LogExporter {
  constructor (config) {
    this._formatter = new Formatter(config)
  }

  export (spans) {
    let size = TRACE_FORMAT_OVERHEAD
    let queue = []

    for (const span of spans) {
      // TODO: write directly to a buffer with an encoder instead
      const spanData = this._formatter.format(span)
      const spanStr = JSON.stringify(spanData)
      if (spanStr.length + TRACE_FORMAT_OVERHEAD > MAX_SIZE) {
        continue
      }
      if (spanStr.length + size > MAX_SIZE) {
        this._printSpans(queue)
        queue = []
        size = TRACE_FORMAT_OVERHEAD
      }
      size += spanStr.length + 1 // includes length of ',' character
      queue.push(spanStr)
    }
    if (queue.length > 0) {
      this._printSpans(queue)
    }
  }

  _printSpans (queue) {
    let logLine = TRACE_PREFIX
    let firstTrace = true
    for (const spanStr of queue) {
      if (firstTrace) {
        firstTrace = false
        logLine += spanStr
      } else {
        logLine += ',' + spanStr
      }
    }
    logLine += TRACE_SUFFIX
    process.stdout.write(logLine)
  }
}

module.exports = { LogExporter }
