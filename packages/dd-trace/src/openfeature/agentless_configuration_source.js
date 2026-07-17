'use strict'

const net = require('node:net')
const { storage } = require('../../../datadog-core')
const log = require('../log')

const legacyStorage = storage('legacy')

const MAX_ATTEMPTS = 3
const FIRST_RETRY_MIN_MS = 2000
const FIRST_RETRY_MAX_MS = 10_000
const SECOND_RETRY_MIN_MS = 5000
const SECOND_RETRY_MAX_MS = 30_000
const RETRY_JITTER = 0.2
const FAILURE_WARNING_INTERVAL_MS = 5 * 60 * 1000

class AgentlessConfigurationSource {
  /**
   * @param {object} config - Resolved agentless settings.
   * @param {Function} applyConfiguration - Applies a parsed UFC configuration.
   * @param {object} [options] - Runtime dependencies.
   */
  constructor (config, applyConfiguration, options = {}) {
    this._config = config
    this._applyConfiguration = applyConfiguration
    this._fetch = options.fetch || fetch
    this._apiKey = config.apiKey && canSendApiKey(config.endpoint) ? config.apiKey : undefined
    this._random = options.random || Math.random
    this._now = options.now || Date.now
    this._setTimeout = options.setTimeout || setTimeout
    this._clearTimeout = options.clearTimeout || clearTimeout
    this._started = false
    this._closed = false
    this._polling = false
    this._etag = undefined
    this._timer = undefined
    this._activeRequest = undefined
    this._lastFailureWarning = -Infinity
  }

  /**
   * Starts fixed-delay polling. Repeated calls are idempotent.
   *
   * @returns {void}
   */
  start () {
    if (this._started || this._closed) return
    this._started = true
    this.pollOnce(() => {})
  }

  /**
   * Stops polling and aborts an active request. Repeated calls are idempotent.
   *
   * @returns {void}
   */
  stop () {
    if (this._closed) return
    this._closed = true
    this._started = false
    if (this._timer) {
      this._clearTimeout(this._timer)
      this._timer = undefined
    }
    this._activeRequest?.abort()
    this._activeRequest = undefined
  }

  /**
   * Performs one poll, including bounded retries. Concurrent calls are skipped.
   *
   * @param {Function} callback - Receives the poll outcome.
   * @returns {void}
   */
  pollOnce (callback) {
    if (this._closed) {
      callback(null, { stopped: true })
      return
    }
    if (this._polling) {
      callback(null, { skipped: true })
      return
    }

    this._polling = true
    this._attempt(1, (error, result) => {
      this._polling = false
      if (error && !this._closed) {
        log.debug('Feature Flagging agentless poll failed', error)
      }
      callback(error, result)
      if (this._started && !this._closed) {
        this._timer = this._setTimeout(() => {
          this._timer = undefined
          this.pollOnce(() => {})
        }, this._config.pollIntervalMs)
        this._timer.unref?.()
      }
    })
  }

  /**
   * Executes one request attempt and schedules a retry when appropriate.
   *
   * @param {number} attempt - One-based attempt number.
   * @param {Function} callback - Receives the final poll outcome.
   * @returns {void}
   */
  _attempt (attempt, callback) {
    this._request((error, response) => {
      if (this._closed) {
        callback(null, { stopped: true })
        return
      }

      const retryable = error?.retryable || isRetryableStatus(response?.statusCode)
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = retryDelay(this._config.pollIntervalMs, attempt, this._random())
        this._timer = this._setTimeout(() => {
          this._timer = undefined
          this._attempt(attempt + 1, callback)
        }, delay)
        this._timer.unref?.()
        return
      }

      if (retryable) this._warnFailure(response?.statusCode, error)

      if (error) {
        callback(error)
        return
      }
      callback(null, this._apply(response))
    })
  }

  /**
   * Sends one HTTP request to the agentless endpoint.
   *
   * @param {Function} callback - Receives a request error or buffered response.
   * @returns {void}
   */
  _request (callback) {
    const headers = { 'Accept-Encoding': 'gzip' }
    if (this._apiKey) headers['DD-API-KEY'] = this._apiKey
    if (this._etag) headers['If-None-Match'] = this._etag

    const controller = new AbortController()
    const timeout = this._setTimeout(() => {
      const error = new Error(
        `Feature Flagging agentless request timed out after ${this._config.requestTimeoutMs}ms`
      )
      controller.abort(error)
      finish(requestError(error))
    }, this._config.requestTimeoutMs)
    timeout.unref?.()

    let settled = false
    const finish = (error, response) => {
      if (settled) return
      settled = true
      this._clearTimeout(timeout)
      if (this._activeRequest === controller) this._activeRequest = undefined
      callback(error, response)
    }

    this._activeRequest = controller
    legacyStorage.run({ noop: true }, () => {
      // TODO: Give the polling source an explicitly reusable connection once
      // transport ownership is designed and covered by system tests.
      this._fetch(this._config.endpoint, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      }).then(response => {
        const result = {
          statusCode: response.status,
          etag: response.headers.get('etag') ?? undefined,
          body: '',
        }
        if (response.status !== 200) {
          response.body?.cancel?.().catch(() => {})
          finish(null, result)
          return
        }
        response.text().then(body => {
          result.body = body
          finish(null, result)
        }, error => {
          const message = response.headers.get('content-encoding')?.toLowerCase() === 'gzip'
            ? 'Feature Flagging agentless gzip response could not be decompressed'
            : 'Feature Flagging agentless response body could not be read'
          finish(new Error(message, { cause: error }))
        })
      }, error => finish(requestError(error)))
    })
  }

  /**
   * Applies a successful response while preserving last-known-good state on
   * every failure path.
   *
   * @param {object} response - Buffered HTTP response.
   * @returns {object} Poll outcome.
   */
  _apply (response) {
    const status = response.statusCode
    if (status === 304) return { notModified: true }

    if (status === 401 || status === 403) {
      this._warnFailure(status)
      return { rejected: true, statusCode: status }
    }

    if (status !== 200) return { rejected: true, statusCode: status }

    let configuration
    try {
      configuration = parseConfiguration(response.body)
    } catch (error) {
      log.debug('Feature Flagging agentless endpoint returned malformed UFC payload', error)
      return { rejected: true, malformed: true }
    }

    try {
      this._applyConfiguration(configuration)
    } catch (error) {
      log.debug('Feature Flagging agentless UFC payload could not be applied', error)
      return { rejected: true, applicationFailed: true }
    }

    this._etag = response.etag?.trim() ? response.etag : undefined
    return { applied: true }
  }

  /**
   * Emits a rate-limited warning for authentication or exhausted transient failures.
   *
   * @param {number | undefined} statusCode - Final HTTP status, when available.
   * @param {Error | undefined} error - Final network error, when available.
   * @returns {void}
   */
  _warnFailure (statusCode, error) {
    const now = this._now()
    if (now - this._lastFailureWarning < FAILURE_WARNING_INTERVAL_MS) return
    this._lastFailureWarning = now

    if (statusCode === 401 || statusCode === 403) {
      log.warn(
        'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
        statusCode
      )
    } else if (statusCode) {
      log.warn('Feature Flagging agentless endpoint returned HTTP %d after %d attempts', statusCode, MAX_ATTEMPTS)
    } else {
      log.warn('Feature Flagging agentless request failed after %d attempts', MAX_ATTEMPTS, error)
    }
  }
}

/**
 * Parses enough of the UFC envelope to reject malformed or unrelated JSON
 * before it can replace the last-known-good configuration.
 *
 * @param {string} body - HTTP response body.
 * @returns {object} Parsed UFC configuration.
 */
function parseConfiguration (body) {
  const parsed = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error('Expected a JSON:API Universal Flag Configuration response')
  }
  if (parsed.data.type !== 'universal-flag-configuration') {
    throw new Error('Expected a JSON:API Universal Flag Configuration resource')
  }
  const configuration = parsed.data.attributes

  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
      typeof configuration.createdAt !== 'string' ||
      (configuration.format !== undefined && typeof configuration.format !== 'string') ||
      !configuration.environment || typeof configuration.environment !== 'object' ||
      typeof configuration.environment.name !== 'string' ||
      !configuration.flags || typeof configuration.flags !== 'object' || Array.isArray(configuration.flags)) {
    const keys = configuration && typeof configuration === 'object'
      ? Object.keys(configuration).join(',')
      : typeof configuration
    throw new Error(`Expected a Universal Flag Configuration v1 object; received ${keys}`)
  }
  return configuration
}

/**
 * Wraps a network error and marks it retryable.
 *
 * @param {Error} cause - Network error.
 * @returns {Error} Retryable error.
 */
function requestError (cause) {
  const error = new Error('Feature Flagging agentless request failed', { cause })
  error.retryable = true
  return error
}

/**
 * Keeps API keys off cleartext non-loopback connections while allowing local
 * controlled endpoints used by tests and development.
 *
 * @param {URL} endpoint - Agentless endpoint.
 * @returns {boolean} Whether an API key may be attached.
 */
function canSendApiKey (endpoint) {
  if (endpoint.protocol !== 'http:' || isControlledLocalHost(endpoint.hostname)) return true
  log.error(
    'Not sending the Datadog API key over a non-TLS connection to %s. Configure an https Feature Flagging URL.',
    endpoint.hostname
  )
  return false
}

/**
 * Keeps the cleartext exception local to controlled Feature Flagging test and
 * development endpoints instead of changing authentication for all exporters.
 *
 * @param {string} hostname - Parsed endpoint hostname.
 * @returns {boolean} Whether the hostname is a controlled local target.
 */
function isControlledLocalHost (hostname) {
  return hostname === 'localhost' ||
    hostname === 'host.docker.internal' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    (hostname.startsWith('127.') && net.isIPv4(hostname))
}

/**
 * Reports whether an HTTP response should be retried.
 *
 * @param {number | undefined} status - HTTP status.
 * @returns {boolean} Whether the status is transient.
 */
function isRetryableStatus (status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Computes the Java-compatible bounded retry delay with plus or minus 20%
 * jitter.
 *
 * @param {number} pollIntervalMs - Poll interval.
 * @param {number} attempt - Failed attempt number, one or two.
 * @param {number} random - Random value in the half-open interval [0, 1).
 * @returns {number} Retry delay in milliseconds.
 */
function retryDelay (pollIntervalMs, attempt, random) {
  const base = attempt === 1
    ? clamp(pollIntervalMs / 6, FIRST_RETRY_MIN_MS, FIRST_RETRY_MAX_MS)
    : clamp(pollIntervalMs / 3, SECOND_RETRY_MIN_MS, SECOND_RETRY_MAX_MS)
  return Math.max(1, Math.round(base * (1 - RETRY_JITTER + random * RETRY_JITTER * 2)))
}

/**
 * Clamps a value to an inclusive range.
 *
 * @param {number} value - Input value.
 * @param {number} minimum - Inclusive minimum.
 * @param {number} maximum - Inclusive maximum.
 * @returns {number} Clamped value.
 */
function clamp (value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

module.exports = AgentlessConfigurationSource
