'use strict'

const request = require('../common/request')
const { startupLog } = require('../../startup-log')
const runtimeMetrics = require('../../runtime_metrics')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version
const BaseWriter = require('../common/writer')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

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
    this._retryQueue = []
    this._retryTimer = null
    this._maxRetryQueueSize = config.maxRetryQueueSize || 100
    this._maxRetryAttempts = config.maxRetryAttempts || 3
    this._baseRetryDelay = config.baseRetryDelay || 1000 // 1 second
  }

  _sendPayload (data, count, done) {
    this._sendPayloadWithRetry(data, count, this._wrapDoneCallback(done), 0)
  }

  _wrapDoneCallback (done) {
    let doneCalled = false
    return () => {
      if (!doneCalled) {
        doneCalled = true
        done()
      }
    }
  }

  _sendPayloadWithRetry (data, count, done, retryAttempt = 0) {
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

      // Handle 429 (rate limit) responses with retry logic
      if (status === 429) {
        if (retryAttempt < this._maxRetryAttempts) {
          this._scheduleRetry(data, count, done, retryAttempt)
          return
        }
        // Max retries exceeded, drop the payload
        log.errorWithoutTelemetry('Maximum retry attempts reached for 429 response, dropping payload')
        runtimeMetrics.increment(`${METRIC_PREFIX}.retries.dropped`, true)
        done()
        return
      }

      if (err) {
        log.errorWithoutTelemetry('Error sending payload to the agent (status code: %s)', err.status, err)
        done()
        return
      }

      log.debug('Response from the agent: %s', res)

      // Track successful retry if this was a retry attempt
      if (retryAttempt > 0) {
        runtimeMetrics.increment(`${METRIC_PREFIX}.retries.success`, true)
      }

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

  _scheduleRetry (data, count, done, retryAttempt) {
    // Check if queue is full
    if (this._retryQueue.length >= this._maxRetryQueueSize) {
      log.errorWithoutTelemetry('Retry queue is full, dropping payload')
      runtimeMetrics.increment(`${METRIC_PREFIX}.retries.dropped`, true)
      done()
      return
    }

    // Calculate exponential backoff delay
    const delay = this._baseRetryDelay * (2 ** retryAttempt)
    const scheduledAt = Date.now() + delay

    // Track retry metrics
    runtimeMetrics.increment(`${METRIC_PREFIX}.retries.scheduled`, true)
    runtimeMetrics.increment(`${METRIC_PREFIX}.retries.by.attempt`, `attempt:${retryAttempt + 1}`, true)

    log.debug(`Scheduling retry attempt ${retryAttempt + 1} in ${delay}ms`)

    // Add to retry queue with scheduled time
    this._retryQueue.push({
      data,
      count,
      done,
      retryAttempt: retryAttempt + 1,
      scheduledAt
    })

    // Start processing if not already running
    this._scheduleNextRetry()
  }

  _scheduleNextRetry () {
    // Clear any existing timer
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }

    if (this._retryQueue.length === 0) {
      return
    }

    // Find the next payload that's ready to send
    const now = Date.now()
    let readyIndex = -1

    for (let i = 0; i < this._retryQueue.length; i++) {
      if (this._retryQueue[i].scheduledAt <= now) {
        readyIndex = i
        break
      }
    }

    if (readyIndex >= 0) {
      // Process ready payload immediately
      const payload = this._retryQueue.splice(readyIndex, 1)[0]

      try {
        this._sendPayloadWithRetry(
          payload.data,
          payload.count,
          payload.done,
          payload.retryAttempt
        )
      } catch (err) {
        log.errorWithoutTelemetry('Error processing retry', err)
        runtimeMetrics.increment(`${METRIC_PREFIX}.retries.dropped`, true)
        payload.done()
      }

      // Schedule next immediately if there are more items
      if (this._retryQueue.length > 0) {
        setImmediate(() => this._scheduleNextRetry())
      }
    } else {
      // Nothing ready yet, wait for the earliest one
      const earliestTime = Math.min(...this._retryQueue.map(p => p.scheduledAt))
      const delay = Math.max(0, earliestTime - now)

      this._retryTimer = setTimeout(() => {
        this._retryTimer = null
        this._scheduleNextRetry()
      }, delay)
    }
  }

  _destroy () {
    // Clear pending timer
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }

    // Drain queue and call done callbacks
    while (this._retryQueue.length > 0) {
      const payload = this._retryQueue.shift()
      log.debug('Dropping queued retry due to writer cleanup')
      runtimeMetrics.increment(`${METRIC_PREFIX}.retries.dropped`, true)
      payload.done()
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
      'X-Datadog-Trace-Count': String(count)
    },
    lookup,
    url
  }

  setHeader(options.headers, 'Datadog-Meta-Lang', 'nodejs')
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', process.version)
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', process.jsEngine || 'v8')
  setHeader(options.headers, 'Datadog-Send-Real-Http-Status', 'true')

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
