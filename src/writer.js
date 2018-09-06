'use strict'

const platform = require('./platform')
const log = require('./log')
const format = require('./format')
const encode = require('./encode')
const tracerVersion = require('../lib/version')

class Writer {
  constructor (url, size, processors) {
    this._queue = []
    this._url = url
    this._size = size
    this._processors = processors
  }

  get length () {
    return this._queue.length
  }

  // A trace is considered filtered out if it is undefined, or if it contains no spans
  isTraceFilteredOut (trace) {
    return trace === undefined || trace === []
  }

  applyProcessors (trace) {
    return this._processors.reduce((currentTrace, processor) => {
      // If the trace has been filtered out by a previous processor, we don't need
      // to bother calling the rest
      if (!this.isTraceFilteredOut(currentTrace)) {
        return processor(currentTrace)
      }
    }, trace)
  }

  append (span) {
    const trace = span.context().trace

    if (trace.started.length === trace.finished.length) {
      log.debug(() => `Formatting original trace: ${JSON.stringify(trace.finished)}`)

      const formattedTrace = trace.finished.map(format)

      log.debug(() => `Running formatted trace through any configured processors: ${JSON.stringify(formattedTrace)}`)

      const processedTrace = this.applyProcessors(formattedTrace)

      if (this.isTraceFilteredOut(processedTrace)) {
        log.debug(() => 'Trace was filtered out by processors, nothing to append to queue')
      } else {
        log.debug(() => `Encoding processed trace: ${JSON.stringify(processedTrace)}`)
        const encodedTrace = encode(processedTrace)

        if (this.length < this._size) {
          this._queue.push(encodedTrace)
        } else {
          this._squeeze(encodedTrace)
        }
      }
    }
  }

  flush () {
    if (this._queue.length > 0) {
      const data = platform.msgpack.prefix(this._queue)
      const options = {
        protocol: this._url.protocol,
        hostname: this._url.hostname,
        port: this._url.port,
        path: '/v0.3/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': platform.name(),
          'Datadog-Meta-Lang-Version': platform.version(),
          'Datadog-Meta-Lang-Interpreter': platform.engine(),
          'Datadog-Meta-Tracer-Version': tracerVersion,
          'X-Datadog-Trace-Count': String(this._queue.length)
        }
      }

      log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

      platform
        .request(Object.assign({ data }, options))
        .then(res => log.debug(`Response from the agent: ${res}`))
        .catch(e => log.error(e))

      this._queue = []
    }
  }

  _squeeze (trace) {
    const index = Math.floor(Math.random() * this.length)
    this._queue[index] = trace
  }
}

module.exports = Writer
