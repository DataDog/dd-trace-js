const logger = require('../dd-trace/src/log')
// path to require tracer logger

const https = require('https')
const coalesce = require('koalas')

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
    this.apiKey = apiKey
    this.endpoint = '/api/v2/logs'
    this.site = coalesce(site, 'datadoghq.com')
    this.intake = `http-intake.logs.${this.site}`
    this.headers = {
      'DD-API-KEY': this.apiKey,
      'Content-Type': 'application/json'
    }
    this.timer = setInterval(() => {
      this.flush()
    }, this.interval)

    logger.debug(`"started log writer to ${this.url}"`)
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

  log (log, tags, span) {
    const logTags = this.tagString(tags)
    const toLog = {
      'timestamp': Date.now(),
      'message': log.message,
      'hostname': coalesce(log.hostname, this.hostname),
      'ddsource': coalesce(log.ddsource, this.ddsource),
      'service': coalesce(log.service, this.service),
      'status': log.level,
      'ddtags': logTags,
      'dd.trace_id': span.trace_id + '',
      'dd.span_id': span.span_id + ''
    }
    for (const key in log) {
      if (!toLog[key]) {
        toLog[key] = log[key]
      }
    }
    return toLog
  }

  enqueue (log) {
    if (this.buffer.length >= this.buffer_limit) {
      logger.warn(`"log buffer full (limit is ${this.buffer_limit}), dropping log"`)
      this.buffer = []
      return
    }
    this.buffer.push(log)
  }

  shutdown () {
    clearInterval(this.timer)
    this.flush()
  }

  url () {
    return `"https://${this.intake}${this.endpoint}"`
  }

  flush () {
    let logs
    let numLogs
    let encodedLogs

    if (!this.buffer) {
      return
    }

    try {
      logs = this.buffer
      this.buffer = []

      numLogs = logs.length
      encodedLogs = JSON.stringify(logs)
    } catch (error) {
      logger.error(`"failed to encode ${numLogs} logs"`)
      return
    }

    const options = {
      hostname: this.intake,
      port: 443,
      path: this.endpoint,
      method: 'POST',
      headers: this.headers
    }
    let req
    try {
      req = https.request(options, (res) => {
        logger.info(`statusCode: ${res.statusCode}`)
      })
    } catch (error) {
      logger.error(`"failed to send ${numLogs} logs to ${this.intake}"`)
    }
    req.write(encodedLogs)
    req.end()
  }
}

module.exports = V2LogWriter
