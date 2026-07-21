'use strict'

const { pipeline } = require('node:stream')
const { createGunzip } = require('node:zlib')

const { parser, pick, streamValues } = require('../../../../vendor/dist/stream-json')
const request = require('../exporters/common/request')
const { getClientLibraryHeaders } = require('../exporters/common/client-library-headers')
const log = require('../log')

const MAX_ATTEMPTS = 3
const FIRST_RETRY_MIN_MS = 2000
const FIRST_RETRY_MAX_MS = 10_000
const SECOND_RETRY_MIN_MS = 5000
const SECOND_RETRY_MAX_MS = 30_000
const RETRY_JITTER = 0.2
const FAILURE_WARNING_INTERVAL_MS = 5 * 60 * 1000

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
 * @property {number} statusCode
 * @property {string | undefined} etag
 * @property {UniversalFlagConfiguration | undefined} configuration
 */

class RetryableRequestError extends Error {}
class MalformedPayloadError extends Error {}
class ResponseReadError extends Error {}

class AgentlessConfigurationSource {
  /** @type {import('node:http').ClientRequest | undefined} */
  #activeRequest

  /** @type {(configuration: UniversalFlagConfiguration) => void} */
  #applyConfiguration

  #closed = false

  /** @type {AgentlessSourceConfig} */
  #config

  /** @type {string | undefined} */
  #etag

  #lastFailureWarning = -Infinity

  /** @type {(() => void) | undefined} */
  #resumeRetry

  #started = false

  /** @type {NodeJS.Timeout | undefined} */
  #timer

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
    if (this.#closed || this.#started) return
    this.#started = true
    this.#poll()
  }

  /**
   * @returns {void}
   */
  stop () {
    if (this.#closed) return
    this.#closed = true

    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    const resumeRetry = this.#resumeRetry
    this.#resumeRetry = undefined
    resumeRetry?.()

    this.#activeRequest?.destroy()
    this.#activeRequest = undefined
  }

  /**
   * @returns {void}
   */
  #poll () {
    this.#attempt(1).then(
      this.#finishPoll.bind(this, undefined),
      this.#finishPoll.bind(this)
    )
  }

  /**
   * @param {Error | undefined} error
   * @returns {void}
   */
  #finishPoll (error) {
    if (error && !this.#closed) {
      if (error instanceof MalformedPayloadError) {
        log.debug('Feature Flagging agentless endpoint returned malformed UFC payload: %s', error.message)
      } else {
        log.debug('Feature Flagging agentless poll failed: %s', error.message)
        if (error instanceof ResponseReadError) this.#warnFailure(undefined, error, 1)
      }
    }

    if (!this.#closed) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        this.#poll()
      }, this.#config.pollIntervalMs)
      this.#timer.unref?.()
    }
  }

  /**
   * @param {number} attempt
   * @returns {Promise<object>}
   */
  #attempt (attempt) {
    return this.#request().then(
      this.#handleResponse.bind(this, attempt),
      this.#handleError.bind(this, attempt)
    )
  }

  /**
   * @param {number} attempt
   * @param {PollResponse} response
   * @returns {object | Promise<object>}
   */
  #handleResponse (attempt, response) {
    if (this.#closed) return { stopped: true }

    if (isRetryableStatus(response.statusCode)) {
      if (attempt < MAX_ATTEMPTS) return this.#waitAndRetry(attempt)
      this.#warnFailure(response.statusCode, undefined, attempt)
    }

    return this.#apply(response)
  }

  /**
   * @param {number} attempt
   * @param {Error} error
   * @returns {object | Promise<object>}
   */
  #handleError (attempt, error) {
    if (this.#closed) return { stopped: true }

    if (error instanceof RetryableRequestError) {
      if (attempt < MAX_ATTEMPTS) return this.#waitAndRetry(attempt)
      this.#warnFailure(undefined, error, attempt)
    }

    throw error
  }

  /**
   * @param {number} attempt
   * @returns {Promise<object>}
   */
  #waitAndRetry (attempt) {
    const delay = retryDelay(this.#config.pollIntervalMs, attempt, Math.random())

    /**
     * @param {() => void} resolve
     */
    const wait = (resolve) => {
      this.#resumeRetry = resolve
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        this.#resumeRetry = undefined
        resolve()
      }, delay)
      this.#timer.unref?.()
    }

    return new Promise(wait).then(
      this.#continueAttempt.bind(this, attempt + 1)
    )
  }

  /**
   * @param {number} attempt
   * @returns {object | Promise<object>}
   */
  #continueAttempt (attempt) {
    return this.#closed ? { stopped: true } : this.#attempt(attempt)
  }

  /**
   * @returns {Promise<PollResponse>}
   */
  #request () {
    const headers = {
      ...getClientLibraryHeaders(),
      'Accept-Encoding': 'gzip',
      'DD-API-KEY': this.#config.apiKey,
    }
    if (this.#etag) headers['If-None-Match'] = this.#etag

    /**
     * @param {(response: PollResponse) => void} resolve
     * @param {(error: Error) => void} reject
     */
    const execute = (resolve, reject) => {
      /**
       * @param {Error | null} error
       * @param {import('node:http').IncomingMessage | null | undefined} response
       */
      const onResponse = (error, response) => {
        if (error) {
          this.#activeRequest = undefined
          reject(new RetryableRequestError('Feature Flagging agentless request failed', { cause: error }))
          return
        }

        if (!response) {
          this.#activeRequest = undefined
          reject(new RetryableRequestError('Feature Flagging agentless request was not sent'))
          return
        }

        const { headers: responseHeaders, statusCode } = response
        const etag = responseHeaders.etag
        const result = {
          statusCode,
          etag: Array.isArray(etag) ? etag[0] : etag,
          configuration: undefined,
        }

        if (statusCode !== 200) {
          this.#activeRequest = undefined
          response.destroy()
          resolve(result)
          return
        }

        this.#parseResponse(response, responseHeaders['content-encoding'], (parseError, configuration) => {
          this.#activeRequest = undefined
          if (parseError) {
            reject(parseError)
          } else {
            result.configuration = configuration
            resolve(result)
          }
        })
      }

      this.#activeRequest = request('', {
        url: this.#config.endpoint,
        method: 'GET',
        headers,
        responseType: 'stream',
        retry: false,
        timeout: this.#config.requestTimeoutMs,
      }, onResponse)
    }

    return new Promise(execute)
  }

  /**
   * @param {import('node:http').IncomingMessage} response
   * @param {string | string[] | undefined} contentEncoding
   * @param {(error: Error | null, configuration?: UniversalFlagConfiguration) => void} callback
   * @returns {void}
   */
  #parseResponse (response, contentEncoding, callback) {
    let attributes
    let resourceType
    let responseError
    let gzipError

    /**
     * @param {{ value: unknown }} entry
     */
    const collectConfiguration = (entry) => {
      if (entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
        resourceType = entry.value.type
        attributes = entry.value.attributes
      } else {
        resourceType = undefined
        attributes = undefined
      }
    }

    /**
     * @param {Error} error
     */
    const rememberResponseError = (error) => {
      responseError = error
    }

    /**
     * @param {Error} error
     */
    const rememberGzipError = (error) => {
      gzipError = error
    }

    /**
     * @param {Error | null | undefined} error
     */
    const finish = (error) => {
      if (error) {
        if (gzipError) {
          callback(new ResponseReadError(
            'Feature Flagging agentless gzip response could not be decompressed',
            { cause: gzipError }
          ))
        } else if (responseError) {
          callback(new ResponseReadError(
            'Feature Flagging agentless response body could not be read',
            { cause: responseError }
          ))
        } else {
          callback(new MalformedPayloadError(
            'Feature Flagging agentless response was malformed',
            { cause: error }
          ))
        }
        return
      }

      try {
        callback(null, validateConfiguration(resourceType, attributes))
      } catch (validationError) {
        callback(new MalformedPayloadError(
          'Feature Flagging agentless response was not a valid UFC resource',
          { cause: validationError }
        ))
      }
    }

    const jsonParser = parser()
    const configurationPicker = pick({ filter: 'data' })
    const configurationValues = streamValues({ reviver: preservePrototypeKey })
    const streams = [response]

    response.once('error', rememberResponseError)
    const encoding = Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding
    if (encoding?.toLowerCase() === 'gzip') {
      const gunzip = createGunzip()
      gunzip.once('error', rememberGzipError)
      streams.push(gunzip)
    }
    streams.push(jsonParser, configurationPicker, configurationValues)

    configurationValues.on('data', collectConfiguration)
    pipeline(...streams, finish)
  }

  /**
   * @param {PollResponse} response
   * @returns {object}
   */
  #apply (response) {
    const status = response.statusCode
    if (status === 304) return { notModified: true }

    if (status === 401 || status === 403) {
      this.#warnFailure(status, undefined, 1)
      return { rejected: true, statusCode: status }
    }

    if (status !== 200) return { rejected: true, statusCode: status }

    try {
      this.#applyConfiguration(response.configuration)
    } catch (error) {
      log.debug('Feature Flagging agentless UFC payload could not be applied: %s', error.message)
      return { rejected: true, applicationFailed: true }
    }

    const etag = response.etag?.trim()
    this.#etag = etag || undefined
    return { applied: true }
  }

  /**
   * @param {number | undefined} statusCode
   * @param {Error | undefined} error
   * @param {number} attempts
   * @returns {void}
   */
  #warnFailure (statusCode, error, attempts) {
    const now = Date.now()
    if (now - this.#lastFailureWarning < FAILURE_WARNING_INTERVAL_MS) return
    this.#lastFailureWarning = now

    if (statusCode === 401 || statusCode === 403) {
      log.warn(
        'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
        statusCode
      )
    } else if (statusCode) {
      log.warn('Feature Flagging agentless endpoint returned HTTP %d after %d attempts', statusCode, attempts)
    } else if (attempts > 1) {
      log.warn('Feature Flagging agentless request failed after %d attempts: %s', attempts, error.message)
    } else {
      log.warn('Feature Flagging agentless request failed: %s', error.message)
    }
  }
}

/**
 * @param {unknown} resourceType
 * @param {unknown} attributes
 * @returns {UniversalFlagConfiguration}
 */
function validateConfiguration (resourceType, attributes) {
  if (resourceType !== 'universal-flag-configuration') {
    throw new Error('Expected a JSON:API Universal Flag Configuration resource')
  }

  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) ||
      typeof attributes.createdAt !== 'string' ||
      (attributes.format !== undefined && typeof attributes.format !== 'string') ||
      !attributes.environment || typeof attributes.environment !== 'object' ||
      Array.isArray(attributes.environment) ||
      typeof attributes.environment.name !== 'string' ||
      !attributes.flags || typeof attributes.flags !== 'object' || Array.isArray(attributes.flags)) {
    const keys = attributes && typeof attributes === 'object'
      ? Object.keys(attributes).join(',')
      : typeof attributes
    throw new Error(`Expected a Universal Flag Configuration v1 object; received ${keys}`)
  }

  return attributes
}

/**
 * @this {Record<string, unknown>}
 * @param {string} key
 * @param {unknown} value
 */
function preservePrototypeKey (key, value) {
  if (key === '__proto__') {
    Object.defineProperty(this, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
    return
  }

  return value
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
