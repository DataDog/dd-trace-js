'use strict'

/* eslint-disable no-await-in-loop -- Polls and retries must remain sequential. */

const { setTimeout: sleep } = require('node:timers/promises')

const request = require('../exporters/common/request')
const { getClientLibraryHeaders } = require('../exporters/common/client-library-headers')
const log = require('../log')

const MAX_ATTEMPTS = 3
const FIRST_RETRY_MIN_MS = 2000
const FIRST_RETRY_MAX_MS = 10_000
const SECOND_RETRY_MIN_MS = 5000
const SECOND_RETRY_MAX_MS = 30_000
const RETRY_JITTER = 0.2
const POLL_FAILED_WITHOUT_CONFIGURATION = 'Feature Flags: agentless configuration poll failed (%s); ' +
  'no configuration has been applied yet, so flag evaluations return their default values'

/**
 * @typedef {object} AgentlessSourceConfig
 * @property {URL} endpoint
 * @property {number} pollIntervalMs
 * @property {number} requestTimeoutMs
 * @property {string | undefined} apiKey
 * @property {string | undefined} env
 */

/**
 * @typedef {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} UniversalFlagConfiguration
 */

/**
 * @typedef {object} PollResponse
 * @property {Error | null | undefined} error
 * @property {string | undefined} body
 * @property {number | undefined} statusCode
 * @property {import('node:http').IncomingHttpHeaders | undefined} headers
 */

class AgentlessConfigurationSource {
  /** @type {AbortController | undefined} */
  #abortController

  /** @type {(configuration: UniversalFlagConfiguration) => void} */
  #applyConfiguration

  #applicationFailureLogged = false

  /** @type {string | undefined} */
  #appliedCreatedAt

  /** @type {AgentlessSourceConfig} */
  #config

  /** @type {string | undefined} */
  #etag

  #failedPolls = 0

  /** @type {Set<string>} */
  #failureWarnings = new Set()

  #malformedPayloadLogged = false

  /**
   * @param {AgentlessSourceConfig} config
   * @param {(configuration: UniversalFlagConfiguration) => void} applyConfiguration
   */
  constructor (config, applyConfiguration) {
    this.#config = config
    this.#applyConfiguration = applyConfiguration
  }

  start () {
    if (this.#abortController) return

    const abortController = new AbortController()
    this.#abortController = abortController
    this.#poll(abortController)
  }

  stop () {
    if (!this.#abortController) return

    this.#abortController.abort()
    this.#abortController = undefined
    log.debug('Feature Flags: agentless configuration polling stopped')
  }

  /**
   * @param {AbortController} abortController
   * @returns {Promise<void>}
   */
  async #poll (abortController) {
    try {
      do {
        await this.#pollOnce(abortController)
      } while (
        this.#abortController === abortController &&
        await wait(this.#config.pollIntervalMs, abortController.signal)
      )
    } catch (error) {
      if (this.#abortController === abortController) {
        this.#warnFailure(undefined, error, 1)
      }
    } finally {
      if (this.#abortController === abortController) {
        this.#abortController = undefined
      }
    }
  }

  /**
   * @param {AbortController} abortController
   * @returns {Promise<void>}
   */
  async #pollOnce (abortController) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log.debug('Feature Flags: agentless configuration poll attempt %d/%d', attempt, MAX_ATTEMPTS)
      const response = await this.#request(abortController.signal)
      if (this.#abortController !== abortController) return

      if (response.statusCode === 304) {
        // 304 means the cached configuration is still valid, not a failure.
        log.debug('Feature Flags: agentless configuration poll attempt %d/%d returned HTTP 304 (unchanged)',
          attempt, MAX_ATTEMPTS)
      } else if (response.statusCode === undefined) {
        log.debug('Feature Flags: agentless configuration poll attempt %d/%d failed: %s',
          attempt, MAX_ATTEMPTS, errorMessage(response.error))
      } else {
        // Avoids errorMessage(response.error), which embeds the full request URL.
        log.debug('Feature Flags: agentless configuration poll attempt %d/%d returned HTTP %d',
          attempt, MAX_ATTEMPTS, response.statusCode)
      }

      const retryable = response.statusCode === undefined || isRetryableStatus(response.statusCode)
      if (!retryable) {
        this.#apply(response)
        return
      }

      if (attempt === MAX_ATTEMPTS) {
        this.#warnFailure(response.statusCode, response.error, attempt)
        this.#logPollFailure('retries exhausted')
        return
      }

      const delay = retryDelay(this.#config.pollIntervalMs, attempt, Math.random())
      log.debug('Feature Flags: agentless configuration poll attempt %d/%d is retryable; retrying in %dms',
        attempt, MAX_ATTEMPTS, delay)
      if (!await wait(delay, abortController.signal)) return
    }
  }

  /**
   * @param {AbortSignal} signal
   * @returns {Promise<PollResponse>}
   */
  #request (signal) {
    const headers = getClientLibraryHeaders()
    headers['Accept-Encoding'] = 'gzip'
    if (this.#config.apiKey) headers['DD-API-KEY'] = this.#config.apiKey
    if (this.#etag) headers['If-None-Match'] = this.#etag

    /**
     * @param {(response: PollResponse) => void} resolve
     */
    const execute = (resolve) => {
      /**
       * @param {Error | null} error
       * @param {string | import('node:http').IncomingMessage | null | undefined} body
       * @param {number | undefined} statusCode
       * @param {import('node:http').IncomingHttpHeaders | undefined} responseHeaders
       */
      const onResponse = (error, body, statusCode, responseHeaders) => {
        resolve({
          error,
          body: typeof body === 'string' ? body : undefined,
          statusCode,
          headers: responseHeaders,
        })
      }

      request('', {
        url: this.#config.endpoint,
        method: 'GET',
        headers,
        retry: false,
        signal,
        timeout: this.#config.requestTimeoutMs,
      }, onResponse)
    }

    return new Promise(execute)
  }

  /**
   * @param {PollResponse} response
   */
  #apply (response) {
    const statusCode = response.statusCode
    if (statusCode === 304) {
      this.#logPollRecovery()
      return
    }

    if (statusCode === 401 || statusCode === 403) {
      this.#warnFailure(statusCode, undefined, 1)
      this.#logPollFailure('authentication failed, not retried')
      return
    }

    if (statusCode !== 200) {
      this.#logPollFailure('HTTP status is not retryable')
      return
    }

    let configuration
    try {
      configuration = parseConfiguration(response.body)
    } catch (error) {
      if (!this.#malformedPayloadLogged) {
        this.#malformedPayloadLogged = true
        log.error('Feature Flagging agentless endpoint returned malformed UFC payload')
      }
      // JSON.parse messages quote the payload, so only report our own validation reasons.
      log.debug('Feature Flags: agentless configuration payload rejected: %s',
        error instanceof SyntaxError ? 'response body is not valid JSON' : error.message)
      this.#logPollFailure('malformed UFC payload')
      return
    }

    try {
      this.#applyConfiguration(configuration)
    } catch (error) {
      if (!this.#applicationFailureLogged) {
        this.#applicationFailureLogged = true
        log.warn('Feature Flagging agentless UFC payload could not be applied: %s', errorMessage(error))
      }
      this.#logPollFailure('configuration could not be applied')
      return
    }

    const etag = response.headers?.etag
    const value = Array.isArray(etag) ? etag[0] : etag
    this.#etag = value?.trim() || undefined
    this.#appliedCreatedAt = configuration.createdAt

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => {
      try {
        const flagCount = Object.keys(configuration.flags ?? {}).length
        // A custom endpoint is requested as configured, so DD_ENV is only sent when the URL carries dd_env.
        const requestedEnv = this.#config.endpoint.searchParams.get('dd_env')
        return 'Feature Flags: agentless configuration applied successfully ' +
          `(${flagCount} flag(s) received; per-flag validity is checked at evaluation, ` +
          `configuration environment=${configuration.environment.name}, ` +
          `createdAt=${configuration.createdAt}, etag=${this.#etag ?? 'none'}, ` +
          `sdk env=${this.#config.env ?? 'unset'}, requested dd_env=${requestedEnv ?? 'not sent'})`
      } catch {
        return 'Feature Flags: configuration applied; diagnostic details unavailable'
      }
    })
    this.#logPollRecovery()
  }

  /**
   * @param {string} reason
   */
  #logPollFailure (reason) {
    this.#failedPolls++
    if (this.#appliedCreatedAt === undefined) {
      log.debug(POLL_FAILED_WITHOUT_CONFIGURATION, reason)
    } else {
      log.debug('Feature Flags: agentless configuration poll failed (%s); keeping the configuration created at %s',
        reason, this.#appliedCreatedAt)
    }
  }

  #logPollRecovery () {
    if (this.#failedPolls === 0) return

    log.debug('Feature Flags: agentless configuration poll succeeded after %d failed poll(s)', this.#failedPolls)
    this.#failedPolls = 0
  }

  /**
   * @param {number | undefined} statusCode
   * @param {unknown} error
   * @param {number} attempts
   */
  #warnFailure (statusCode, error, attempts) {
    const category = statusCode === 401 || statusCode === 403
      ? 'authentication'
      : statusCode ? 'http' : 'request'
    if (this.#failureWarnings.has(category)) return
    this.#failureWarnings.add(category)

    if (statusCode === 401 || statusCode === 403) {
      log.warn('Feature Flagging agentless endpoint returned HTTP %d; verify endpoint authentication', statusCode)
    } else if (statusCode) {
      log.warn('Feature Flagging agentless endpoint returned HTTP %d after %d attempts', statusCode, attempts)
    } else if (attempts > 1) {
      log.warn('Feature Flagging agentless request failed after %d attempts: %s', attempts, errorMessage(error))
    } else {
      log.warn('Feature Flagging agentless request failed: %s', errorMessage(error))
    }
  }
}

/**
 * @param {number} delay
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
async function wait (delay, signal) {
  try {
    await sleep(delay, undefined, { ref: false, signal })
    return true
  } catch (error) {
    if (error?.name === 'AbortError') return false
    throw error
  }
}

/**
 * @param {string | undefined} body
 * @returns {UniversalFlagConfiguration}
 */
function parseConfiguration (body) {
  const { data } = JSON.parse(body)
  if (data?.type !== 'universal-flag-configuration') {
    throw new Error('Expected a JSON:API Universal Flag Configuration resource')
  }

  const { attributes } = data
  if (typeof attributes?.format !== 'string' ||
      typeof attributes.createdAt !== 'string' ||
      typeof attributes.environment?.name !== 'string' ||
      !attributes.flags ||
      typeof attributes.flags !== 'object' ||
      Array.isArray(attributes.flags)) {
    throw new Error('Expected a Universal Flag Configuration v1 object')
  }

  return attributes
}

/**
 * Formats a request error, including the underlying network error code
 * (e.g. ENOTFOUND, ECONNREFUSED, ETIMEDOUT) when available, since "request
 * failed" alone does not tell a customer whether the problem is DNS, a
 * refused connection, a timeout, or something else.
 *
 * @param {unknown} error
 */
function errorMessage (error) {
  if (!(error instanceof Error)) return String(error ?? 'request was not sent')
  const code = /** @type {{ code?: string }} */ (error).code
  return code ? `${error.message} (${code})` : error.message
}

/**
 * @param {number | undefined} status
 */
function isRetryableStatus (status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * @param {number} pollIntervalMs
 * @param {number} attempt
 * @param {number} random
 */
function retryDelay (pollIntervalMs, attempt, random) {
  const base = attempt === 1
    ? clamp(pollIntervalMs / 6, FIRST_RETRY_MIN_MS, FIRST_RETRY_MAX_MS)
    : clamp(pollIntervalMs / 3, SECOND_RETRY_MIN_MS, SECOND_RETRY_MAX_MS)
  return Math.max(1, Math.round(base * (1 - RETRY_JITTER + random * RETRY_JITTER * 2)))
}

/**
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 */
function clamp (value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

module.exports = AgentlessConfigurationSource
