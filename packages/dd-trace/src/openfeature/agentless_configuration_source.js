'use strict'

const { storage } = require('../../../datadog-core')
const log = require('../log')

const legacyStorage = storage('legacy')

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
    this._apiKey = config.apiKey
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
    const headers = { 'Accept-Encoding': 'gzip' }
    if (this._apiKey) headers['DD-API-KEY'] = this._apiKey
    if (this._etag) headers['If-None-Match'] = this._etag

    legacyStorage.run({ noop: true }, () => {
      // TODO: Give the polling source an explicitly reusable connection once
      // transport ownership is designed and covered by system tests.
      this._fetch(this._config.endpoint, {
        method: 'GET',
        headers,
        redirect: 'manual',
      }).then(response => {
        const result = {
          statusCode: response.status,
          etag: response.headers.get('etag') ?? undefined,
          body: '',
        }
        if (response.status !== 200) {
          response.body?.cancel?.().catch(() => {})
          callback(null, result)
          return
        }
        response.text().then(body => {
          result.body = body
          callback(null, result)
        }, error => {
          const message = response.headers.get('content-encoding')?.toLowerCase() === 'gzip'
            ? 'Feature Flagging agentless gzip response could not be decompressed'
            : 'Feature Flagging agentless response body could not be read'
          callback(new Error(message, { cause: error }))
        })
      }, error => callback(requestError(error)))
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
      log.warn(
        'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
        status
      )
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

module.exports = AgentlessConfigurationSource
