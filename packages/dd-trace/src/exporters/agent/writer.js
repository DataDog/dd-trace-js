'use strict'

const request = require('./request')
const { startupLog } = require('../../startup-log')
const metrics = require('../../metrics')
const log = require('../../log')
const tracerVersion = require('../../../lib/version')
const BaseWriter = require('../common/writer')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

class Writer extends BaseWriter {
  constructor ({ prioritySampler, lookup, protocolVersion }) {
    super(...arguments)
    const AgentEncoder = getEncoder(protocolVersion)

    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._protocolVersion = protocolVersion
    this._encoder = new AgentEncoder(this)
  }

  _sendPayload (data, count, done) {
    metrics.increment(`${METRIC_PREFIX}.requests`, true)

    makeRequest(this._protocolVersion, data, count, this._url, this._lookup, true, (err, res, status) => {
      if (status) {
        metrics.increment(`${METRIC_PREFIX}.responses`, true)
        metrics.increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true)
      } else if (err) {
        metrics.increment(`${METRIC_PREFIX}.errors`, true)
        metrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)

        if (err.code) {
          metrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
      }

      startupLog({ agentError: err })

      if (err) {
        log.error(err)
        done()
        return
      }

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(e)

        metrics.increment(`${METRIC_PREFIX}.errors`, true)
        metrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
      }
      done()
    })
  }
}

function setHeader (headers, key, value) {
  if (value) {
    headers[key] = value
  }
}

function getEncoder (protocolVersion) {
  if (protocolVersion === '0.5') {
    return require('../../encode/0.5').AgentEncoder
  } else {
    return require('../../encode/0.4').AgentEncoder
  }
}

function makeRequest (version, data, count, url, lookup, needsStartupLog, cb) {
  const options = {
    path: `/v${version}/traces`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/msgpack',
      'Datadog-Meta-Tracer-Version': tracerVersion,
      'X-Datadog-Trace-Count': String(count)
    },
    lookup
  }

  setHeader(options.headers, 'Datadog-Meta-Lang', 'nodejs')
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', process.version)
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', process.jsEngine || 'v8')

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

  request(Object.assign({ data }, options), (err, res, status) => {
    if (needsStartupLog) {
      // Note that logging will only happen once, regardless of how many times this is called.
      startupLog({
        agentError: status !== 404 && status !== 200 ? err : undefined
      })
    }
    cb(err, res, status)
  })
}

module.exports = Writer
