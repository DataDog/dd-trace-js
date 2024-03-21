const tracerLogger = require('../../log')// path to require tracer logger

const https = require('https')

class ExternalLogger {
  // Note: these attribute names match the corresponding entry in the JSON payload.
  constructor ({
    ddsource, hostname, service, apiKey, site = 'datadoghq.com', interval = 10000, timeout = 2000, limit = 1000
  }) {
    this.enabled = !!apiKey

    this.ddsource = ddsource
    this.hostname = hostname
    this.service = service
    this.interval = interval
    this.timeout = timeout
    this.queue = []
    this.limit = limit
    this.endpoint = '/api/v2/logs'
    this.site = site
    this.intake = `http-intake.logs.${this.site}`
    this.headers = {
      'DD-API-KEY': apiKey,
      'Content-Type': 'application/json'
    }
    this.timer = setInterval(() => {
      this.flush()
    }, this.interval).unref()

    tracerLogger.debug(`started log writer to https://${this.intake}${this.endpoint}`)
  }

  static tagString (tags) {
    const tagArray = []
    for (const key in tags) {
      tagArray.push(key + ':' + tags[key])
    }
    return tagArray.join(',')
  }

  // Parses and enqueues a log
  log (log, span, tags) {
    if (!this.enabled) return

    const logTags = ExternalLogger.tagString(tags)

    if (span) {
      log['dd.trace_id'] = String(span.trace_id)
      log['dd.span_id'] = String(span.span_id)
    }

    const payload = {
      ...log,
      timestamp: Date.now(),
      hostname: log.hostname || this.hostname,
      ddsource: log.ddsource || this.ddsource,
      service: log.service || this.service,
      ddtags: logTags || undefined
    }

    this.enqueue(payload)
  }

  // Enqueues a raw, non-formatted log object
  enqueue (log) {
    if (this.queue.length >= this.limit) {
      this.flush()
    }
    this.queue.push(log)
  }

  shutdown () {
    clearInterval(this.timer)
    this.flush()
  }

  // Flushes logs with optional callback for when the call is complete
  flush (cb = () => {}) {
    let logs
    let numLogs
    let encodedLogs

    if (!this.queue.length) {
      setImmediate(() => cb())
      return
    }

    try {
      logs = this.queue
      this.queue = []

      numLogs = logs.length
      encodedLogs = JSON.stringify(logs)
    } catch (error) {
      tracerLogger.error(`failed to encode ${numLogs} logs`)
      setImmediate(() => cb(error))
      return
    }

    const options = {
      hostname: this.intake,
      port: 443,
      path: this.endpoint,
      method: 'POST',
      headers: this.headers,
      timeout: this.timeout
    }

    const req = https.request(options, (res) => {
      tracerLogger.info(`statusCode: ${res.statusCode}`)
    })
    req.once('error', (e) => {
      tracerLogger.error(`failed to send ${numLogs} log(s), with error ${e.message}`)
      cb(e)
    })
    req.write(encodedLogs)
    req.end()
    req.once('response', (res) => {
      if (res.statusCode >= 400) {
        const error = new Error(`failed to send ${numLogs} logs, received response code ${res.statusCode}`)
        tracerLogger.error(error.message)
        cb(error)
        return
      }
      cb()
    })
  }
}

class NoopExternalLogger {
  log () { }
  enqueue () { }
  shutdown () { }
  flush () { }
}

module.exports.ExternalLogger = ExternalLogger
module.exports.NoopExternalLogger = NoopExternalLogger
