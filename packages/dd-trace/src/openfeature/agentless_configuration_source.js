'use strict'

const http = require('node:http')
const https = require('node:https')
const log = require('../log')

class AgentlessConfigurationSource {
  /**
   * @param {object} config - Resolved agentless settings.
   * @param {Function} applyConfiguration - Applies a parsed UFC configuration.
   * @param {object} [options] - Runtime dependencies.
   */
  constructor (config, applyConfiguration, options = {}) {
    this._config = config
    this._applyConfiguration = applyConfiguration
    this._http = options.http || http
    this._https = options.https || https
    this._etag = undefined
  }

  /**
   * Performs one agentless configuration request.
   *
   * @param {Function} callback - Receives the poll outcome.
   * @returns {void}
   */
  pollOnce (callback) {
    this._request((error, response) => {
      if (error) {
        log.debug('Feature Flagging agentless poll failed', error)
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
    const headers = {}
    if (this._config.apiKey) headers['DD-API-KEY'] = this._config.apiKey
    if (this._etag) headers['If-None-Match'] = this._etag

    const transport = this._config.endpoint.protocol === 'https:' ? this._https : this._http
    let settled = false
    const finish = (error, response) => {
      if (settled) return
      settled = true
      callback(error, response)
    }

    const request = transport.request(this._config.endpoint, { method: 'GET', headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', error => finish(requestError(error)))
      response.on('end', () => {
        finish(null, {
          statusCode: response.statusCode,
          etag: response.headers.etag,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })

    request.setTimeout(this._config.requestTimeoutMs, () => {
      const error = new Error(`Feature Flagging agentless request timed out after ${this._config.requestTimeoutMs}ms`)
      error.retryable = true
      request.destroy(error)
    })
    request.on('error', error => finish(requestError(error)))
    request.end()
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
      log.warn(
        'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
        status
      )
      return { rejected: true, statusCode: status }
    }

    if (status !== 200) return { rejected: true, statusCode: status }

    let configuration
    try {
      configuration = parseConfiguration(response.body, this._config.allowRawConfiguration)
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
}

/**
 * Parses enough of the UFC envelope to reject malformed or unrelated JSON
 * before it can replace the last-known-good configuration.
 *
 * @param {string} body - HTTP response body.
 * @param {boolean} allowRawConfiguration - Allows legacy raw UFC from an explicit custom endpoint.
 * @returns {object} Parsed UFC configuration.
 */
function parseConfiguration (body, allowRawConfiguration) {
  const parsed = JSON.parse(body)
  let configuration

  if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'data')) {
    if (!parsed.data || typeof parsed.data !== 'object' ||
        parsed.data.type !== 'universal-flag-configuration') {
      throw new Error('Expected a JSON:API Universal Flag Configuration resource')
    }
    configuration = parsed.data.attributes
  } else if (allowRawConfiguration) {
    configuration = parsed
  } else {
    throw new Error('Expected a JSON:API Universal Flag Configuration response')
  }

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

module.exports = AgentlessConfigurationSource
