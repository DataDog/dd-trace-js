'use strict'

const request = require('../common/request')
const { startupLog } = require('../../startup-log')
const runtimeMetrics = require('../../runtime_metrics')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version
const BaseWriter = require('../common/writer')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'
const MAX_RETRY_QUEUE_SIZE = 1000
const DEFAULT_INITIAL_BACKOFF_MS = 1000 // 1 second
const DEFAULT_MAX_BACKOFF_MS = 30000 // 30 seconds

class Writer extends BaseWriter {
  constructor ({ prioritySampler, lookup, protocolVersion, headers, config = {} }) {
    super(...arguments)
    const AgentEncoder = getEncoder(protocolVersion)

    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._protocolVersion = protocolVersion
    this._headers = headers
    this._config = config
    this._encoder = new AgentEncoder(this)

    // Retry queue for handling 429 responses with exponential backoff
    this._retryQueue = []
    this._initialBackoff = config.initialBackoff || DEFAULT_INITIAL_BACKOFF_MS
    this._maxBackoff = config.maxBackoff || DEFAULT_MAX_BACKOFF_MS
    this._currentBackoff = this._initialBackoff
    this._retryInProgress = false
    this._retryTimeout = null
  }

  _sendPayload (data, count, done) {
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)

    const { _headers, _lookup, _protocolVersion, _url } = this
    makeRequest(_protocolVersion, data, count, _url, _headers, _lookup, true, (err, res, status) => {
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

      startupLog({ agentError: err })

      // Handle 429 Too Many Requests - queue for retry with exponential backoff
      if (status === 429) {
        log.debug('Received 429 from agent, queueing payload for retry')
        this._queueForRetry(data, count)
        done()
        return
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

  _queueForRetry (data, count) {
    // Don't infinitely queue failed payloads to prevent unbounded memory growth
    if (this._retryQueue.length >= MAX_RETRY_QUEUE_SIZE) {
      log.debug('Retry queue is full, dropping payload')
      return
    }

    this._retryQueue.push({ data, count })
    log.debug('Queued payload for retry. Queue size: %d', this._retryQueue.length)

    // Start processing the retry queue if not already in progress
    if (!this._retryInProgress) {
      this._processRetryQueue()
    }
  }

  _processRetryQueue () {
    if (this._retryInProgress || this._retryQueue.length === 0) {
      return
    }

    this._retryInProgress = true
    this._retryNextPayload()
  }

  _retryNextPayload () {
    if (this._retryQueue.length === 0) {
      this._retryInProgress = false
      this._retryTimeout = null
      return
    }

    log.debug('Retrying payload after %dms backoff', this._currentBackoff)

    this._retryTimeout = setTimeout(() => {
      this._retryTimeout = null

      // Check again after the timeout in case queue was cleared
      if (this._retryQueue.length === 0) {
        this._retryInProgress = false
        return
      }

      const payload = this._retryQueue.shift()
      const { data, count } = payload

      const { _headers, _lookup, _protocolVersion, _url } = this
      makeRequest(_protocolVersion, data, count, _url, _headers, _lookup, false, (err, res, status) => {
        if (status === 429) {
          // Still getting 429, requeue and increase backoff
          log.debug('Retry still received 429, requeueing')
          this._retryQueue.unshift(payload) // Put it back at the front
          this._currentBackoff = Math.min(this._currentBackoff * 2, this._maxBackoff)
          this._retryNextPayload()
        } else if (err) {
          // Other errors, drop the payload and continue with next
          log.debug('Retry failed with error: %s', err.message)
          this._retryNextPayload()
        } else {
          // Success! Reset backoff and continue
          log.debug('Retry succeeded, resetting backoff')
          this._currentBackoff = this._initialBackoff

          try {
            this._prioritySampler.update(JSON.parse(res).rate_by_service)
          } catch (e) {
            log.error('Error updating prioritySampler rates', e)
          }

          this._retryNextPayload()
        }
      })
    }, this._currentBackoff)

    // Unref the timeout so it doesn't keep the process alive
    if (this._retryTimeout.unref) {
      this._retryTimeout.unref()
    }
  }
}

function setHeader (headers, key, value) {
  if (value) {
    headers[key] = value
  }
}

function getEncoder (protocolVersion) {
  return protocolVersion === '0.5'
    ? require('../../encode/0.5').AgentEncoder
    : require('../../encode/0.4').AgentEncoder
}

function makeRequest (version, data, count, url, headers, lookup, needsStartupLog, cb) {
  const options = {
    path: `/v${version}/traces`,
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/msgpack',
      'Datadog-Meta-Tracer-Version': tracerVersion,
      'X-Datadog-Trace-Count': String(count),
      'Datadog-Send-Real-Http-Status': 'true'
    },
    lookup,
    url
  }

  setHeader(options.headers, 'Datadog-Meta-Lang', 'nodejs')
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', process.version)
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', process.jsEngine || 'v8')

  log.debug('Request to the agent: %j', options)

  request(data, options, (err, res, status) => {
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
