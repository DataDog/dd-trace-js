'use strict'

const { inspect } = require('node:util')
const { channel } = require('dc-polyfill')

const commonRequest = require('../common/request')
const { logIntegrations, logAgentError } = require('../../startup-log')
const runtimeMetrics = require('../../runtime_metrics')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version
const BaseWriter = require('../common/writer')
const propagationHash = require('../../propagation-hash')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'
const firstFlushChannel = channel('dd-trace:exporter:first-flush')

class AgentWriter extends BaseWriter {
  #request = commonRequest
  #requestTracker

  constructor (...args) {
    const { isTestOptimization } = args[0]
    super({
      ...args[0],
      beforeFirstFlush: () => firstFlushChannel.publish(),
      retainOnBackpressure: isTestOptimization,
    })
    const { prioritySampler, lookup, protocolVersion, flushInterval, headers } = args[0]

    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._protocolVersion = protocolVersion
    this._headers = headers
    this._encoder = createEncoder(protocolVersion, flushInterval, this)
    if (isTestOptimization) {
      this.#request = require('../../ci-visibility/exporters/request')
      const TestOptimizationRequestTracker = require('../../ci-visibility/exporters/agentless/request-tracker')
      this.#requestTracker = new TestOptimizationRequestTracker(this)
    }
  }

  /**
   * Performs the writer flush without registering a serverless delivery.
   * Test Optimization owns its own request lifecycle tracking.
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flushDirect (done, options) {
    if (this.#requestTracker) {
      this.#requestTracker.flush(done, options)
      return
    }
    super.flushDirect(done, options)
  }

  _sendPayload (data, count, done, flushOptions) {
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)

    const { _headers, _lookup, _protocolVersion, _url } = this
    const onResponse = (err, res, status, headers) => {
      if (err?.code === 'ERR_DD_IDENTITY_REFRESH') {
        done()
        return
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
        done(flushOptions?.deadline === undefined ? undefined : err)
        return
      }

      log.debug('Response from the agent: %s', res)

      // Capture container tags hash from agent response headers
      // The hash is sent by the agent only when Datadog-Container-ID is present in the request
      // (Datadog-Container-ID is automatically injected by docker.inject() in exporters/common/request.js)
      if (headers) {
        const containerTagsHash = headers['Datadog-Container-Tags-Hash']
        if (containerTagsHash) {
          propagationHash.updateContainerTagsHash(containerTagsHash)
        }
      }

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error('Error updating prioritySampler rates', e)

        runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
      }
      done()
    }
    makeRequest(
      _protocolVersion,
      data,
      count,
      _url,
      _headers,
      _lookup,
      flushOptions,
      this.#request,
      this.#requestTracker,
      this._resetController,
      onResponse
    )
  }
}

/**
 * @param {string} protocolVersion
 * @param {number | undefined} flushInterval
 * @param {AgentWriter} writer
 * @returns {import('../../encode/0.4').AgentEncoder}
 */
function createEncoder (protocolVersion, flushInterval, writer) {
  if (protocolVersion === '0.5') {
    const { AgentEncoder } = require('../../encode/0.5')
    return new AgentEncoder(writer)
  }
  if (flushInterval === 0) {
    const { createAgentEncoder } = require('../../encode/0.4-cross-payload')
    const disableCrossPayloadCache = () => {
      writer._encoder = createEncoder('0.4', undefined, writer)
    }
    return createAgentEncoder(writer, disableCrossPayloadCache)
  }
  const { AgentEncoder } = require('../../encode/0.4')
  return new AgentEncoder(writer)
}

function makeRequest (version, data, count, url, headers, lookup, flushOptions, request, requestTracker,
  resetController, cb) {
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
    resetController,
    url,
  }
  if (flushOptions?.deadline !== undefined) {
    options.deadline = flushOptions.deadline
  }

  log.debug('Request to the agent: %j', options)

  const onResponse = (err, res, status, headers) => {
    if (err?.code === 'ERR_DD_IDENTITY_REFRESH') {
      cb(err, res, status, headers)
      return
    }

    logIntegrations()
    if (status !== 404 && status !== 200 && err) {
      logAgentError({ status, message: err.message ?? inspect(err) })
    }
    cb(err, res, status, headers)
  }
  if (requestTracker) requestTracker.send(request, data, options, onResponse)
  else request(data, options, onResponse)
}

module.exports = AgentWriter
