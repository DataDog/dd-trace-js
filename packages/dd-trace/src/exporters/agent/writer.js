'use strict'

const { inspect } = require('util')

const request = require('../common/request')
const { logAgentError } = require('../../startup-log')
const runtimeMetrics = require('../../runtime_metrics')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version
const BaseWriter = require('../common/writer')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

class AgentWriter extends BaseWriter {
  constructor (...args) {
    super(...args)
    const { prioritySampler, lookup, protocolVersion, headers, config = {} } = args[0]
    const AgentEncoder = getEncoder(protocolVersion)

    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._protocolVersion = protocolVersion
    this._headers = headers
    this._config = config
    this._encoder = new AgentEncoder(this)
  }

  _sendPayload (data, count, done) {
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)

    const { _headers, _lookup, _protocolVersion, _url } = this
    makeRequest(_protocolVersion, data, count, _url, _headers, _lookup, (err, res, status) => {
      // Log agent connection diagnostic error (only once)
      if (status && status !== 404 && status !== 200) {
        logAgentError({ status, message: err?.message ?? inspect(err) })
      }

      if (status) {
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true)
      } else if (err) {
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)

        if (err.code) {
          runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
      }

      if (err) {
        log.errorWithoutTelemetry('Error sending payload to the agent (status code: %s)', err.status, err)
        done()
        return
      }

      log.debug('Response from the agent: %s', res)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error('Error updating prioritySampler rates', e)

        runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
      }
      done()
    })
  }
}

function getEncoder (protocolVersion) {
  return protocolVersion === '0.5'
    ? require('../../encode/0.5').AgentEncoder
    : require('../../encode/0.4').AgentEncoder
}

function makeRequest (version, data, count, url, headers, lookup, cb) {
  const options = {
    path: `/v${version}/traces`,
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/msgpack',
      'Datadog-Meta-Tracer-Version': tracerVersion,
      'X-Datadog-Trace-Count': String(count),
      'Datadog-Meta-Lang': 'nodejs',
      'Datadog-Meta-Lang-Version': process.version,
      'Datadog-Meta-Lang-Interpreter': process.versions.bun ? 'JavaScriptCore' : 'v8',
    },
    lookup,
    url,
  }

  log.debug('Request to the agent: %j', options)

  request(data, options, cb)
}

module.exports = AgentWriter
