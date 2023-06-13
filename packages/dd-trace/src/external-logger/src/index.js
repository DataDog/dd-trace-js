const tracerLogger = require('../../log')// path to require tracer logger

const https = require('https')

class V2LogWriter {
  // Note: these attribute names match the corresponding entry in the JSON payload.
  constructor ({ ddsource, hostname, service, site, apiKey, interval, timeout }) {
    this.ddsource = ddsource
    this.hostname = hostname
    this.service = service
    this.interval = interval
    this.timeout = timeout
    this.buffer = []
    this.buffer_limit = 1000
    this.endpoint = '/api/v2/logs'
    this.site = site || 'datadoghq.com'
    this.intake = `http-intake.logs.${this.site}`
    this.headers = {
      'DD-API-KEY': apiKey,
      'Content-Type': 'application/json'
    }
    this.timer = setInterval(() => {
      this.flush()
    }, this.interval)

    tracerLogger.debug(`started log writer to https://${this.intake}${this.endpoint}`)
  }

  start () {
    this.timer()
  }

  tagString (tags) {
    let tagStr = ''
    for (const key in tags) {
      tagStr += key + ':' + tags[key] + ','
    }
    return tagStr
  }

  log (log, span, tags) {
    const logTags = this.tagString(tags)
    if (span) {
      log['dd.trace_id'] = span.trace_id + ''
      log['dd.span_id'] = span.span_id + ''
    }
    const toLog = {
      ...log,
      'timestamp': Date.now(),
      'hostname': log.hostname || this.hostname,
      'ddsource': log.ddsource || this.ddsource,
      'service': log.service || this.service,
      'ddtags': logTags || undefined
    }

    return toLog
  }

  enqueue (log) {
    if (this.buffer.length >= this.buffer_limit) {
      this.flush()
    }
    this.buffer.push(log)
  }

  shutdown () {
    clearInterval(this.timer)
    this.flush()
  }

  flush () {
    let logs
    let numLogs
    let encodedLogs

    if (!this.buffer.length) {
      return
    }

    try {
      logs = this.buffer
      this.buffer = []

      numLogs = logs.length
      encodedLogs = JSON.stringify(logs)
    } catch (error) {
      tracerLogger.error(`failed to encode ${numLogs} logs`)
      return
    }

    const options = {
      hostname: this.intake,
      port: 443,
      path: this.endpoint,
      method: 'POST',
      headers: this.headers
    }

    const req = https.request(options, (res) => {
      tracerLogger.info(`statusCode: ${res.statusCode}`)
    })
    req.on('error', (e) => {
      tracerLogger.error(`failed to send ${numLogs} with error ${e.message}`)
    })
    req.write(encodedLogs)
    req.end()
    req.once('response', (res) => {
      if (res.statusCode >= 300) {
        tracerLogger.error(`failed to send ${numLogs} logs received response code ${res.statusCode}`)
      }
    })
  }
}

module.exports = V2LogWriter
