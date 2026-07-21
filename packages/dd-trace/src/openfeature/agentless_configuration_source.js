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

/**
 * @typedef {object} AgentlessSourceConfig
 * @property {URL} endpoint
 * @property {number} pollIntervalMs
 * @property {number} requestTimeoutMs
 * @property {string} apiKey
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

  /** @type {AgentlessSourceConfig} */
  #config

  /** @type {string | undefined} */
  #etag

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

  /**
   * @returns {void}
   */
  start () {
    if (this.#abortController) return

    const abortController = new AbortController()
    this.#abortController = abortController
    this.#poll(abortController)
  }

  /**
   * @returns {void}
   */
  stop () {
    this.#abortController?.abort()
    this.#abortController = undefined
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
      const response = await this.#request(abortController.signal)
      if (this.#abortController !== abortController) return

      const retryable = response.statusCode === undefined || isRetryableStatus(response.statusCode)
      if (!retryable) {
        this.#apply(response)
        return
      }

      if (attempt === MAX_ATTEMPTS) {
        this.#warnFailure(response.statusCode, response.error, attempt)
        return
      }

      const delay = retryDelay(this.#config.pollIntervalMs, attempt, Math.random())
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
    headers['DD-API-KEY'] = this.#config.apiKey
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
   * @returns {void}
   */
  #apply (response) {
    const statusCode = response.statusCode
    if (statusCode === 304) return

    if (statusCode === 401 || statusCode === 403) {
      this.#warnFailure(statusCode, undefined, 1)
      return
    }

    if (statusCode !== 200) return

    let configuration
    try {
      configuration = parseConfiguration(response.body)
    } catch {
      if (!this.#malformedPayloadLogged) {
        this.#malformedPayloadLogged = true
        log.error('Feature Flagging agentless endpoint returned malformed UFC payload')
      }
      return
    }

    try {
      this.#applyConfiguration(configuration)
    } catch (error) {
      if (!this.#applicationFailureLogged) {
        this.#applicationFailureLogged = true
        log.warn('Feature Flagging agentless UFC payload could not be applied: %s', errorMessage(error))
      }
      return
    }

    const etag = response.headers?.etag
    const value = Array.isArray(etag) ? etag[0] : etag
    this.#etag = value?.trim() || undefined
  }

  /**
   * @param {number | undefined} statusCode
   * @param {unknown} error
   * @param {number} attempts
   * @returns {void}
   */
  #warnFailure (statusCode, error, attempts) {
    const category = statusCode === 401 || statusCode === 403
      ? 'authentication'
      : statusCode ? 'http' : 'request'
    if (this.#failureWarnings.has(category)) return
    this.#failureWarnings.add(category)

    if (statusCode === 401 || statusCode === 403) {
      log.warn(
        'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
        statusCode
      )
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
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage (error) {
  return error instanceof Error ? error.message : String(error ?? 'request was not sent')
}

/**
 * @param {number | undefined} status
 * @returns {boolean}
 */
function isRetryableStatus (status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * @param {number} pollIntervalMs
 * @param {number} attempt
 * @param {number} random
 * @returns {number}
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
 * @returns {number}
 */
function clamp (value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

module.exports = AgentlessConfigurationSource
