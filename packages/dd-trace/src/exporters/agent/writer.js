'use strict'

const platform = require('../../platform')
const log = require('../../log')
const tracerVersion = require('../../../lib/version')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

class Writer {
  constructor ({ url, prioritySampler, lookup, protocolVersion }) {
    const AgentEncoder = getEncoder(protocolVersion)

    this._url = url
    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._protocolVersion = protocolVersion
    this._encoderForVersion = new AgentEncoder(this)

    if (url.then) {
      // While we resolve this in makeRequest, re-assigning allows us to skip a
      // `promise.then()` after it has been resolved.
      this._url = Promise.race(url, new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Agent URL promise timed out (1000ms)'))
        }, 1000) // Give user code 1 second to find retrieve a URL
      }))
      url.then(resolvedUrl => {
        this._url = new URL(resolvedUrl)
      })
    }
  }

  append (spans) {
    log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

    this._encode(spans)
  }

  _sendPayload (data, count) {
    platform.metrics().increment(`${METRIC_PREFIX}.requests`, true)

    makeRequest(this._protocolVersion, data, count, this._url, this._lookup, true, (err, res, status) => {
      if (status) {
        platform.metrics().increment(`${METRIC_PREFIX}.responses`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true)
      } else if (err) {
        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)

        if (err.code) {
          platform.metrics().increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
      }

      platform.startupLog.startupLog({ agentError: err })

      if (err) return log.error(err)

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(e)

        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
      }
    })
  }

  _encode (trace) {
    this._encoderForVersion.encode(trace)
  }

  flush () {
    const count = this._encoderForVersion.count()

    if (count > 0) {
      const payload = this._encoderForVersion.makePayload()

      this._sendPayload(payload, count)
    }
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
  if (url.then) {
    url.then(resolvedUrl => {
      makeRequest(version, data, count, new URL(resolvedUrl), lookup, needsStartupLog, cb)
    }, err => {
      if (needsStartupLog) {
        // Note that logging will only happen once, regardless of how many times this is called.
        platform.startupLog.startupLog({ agentError: err })
        cb(err)
      }
    })
    return
  }
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

  setHeader(options.headers, 'Datadog-Meta-Lang', platform.name())
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', platform.version())
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', platform.engine())

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

  platform.request(Object.assign({ data }, options), (err, res, status) => {
    if (needsStartupLog) {
      // Note that logging will only happen once, regardless of how many times this is called.
      platform.startupLog.startupLog({
        agentError: status !== 404 && status !== 200 ? err : undefined
      })
    }
    cb(err, res, status)
  })
}

module.exports = Writer
