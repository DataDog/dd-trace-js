'use strict'

const { getValueFromEnvSources } = require('../../config/helper')
const log = require('../../log')
const request = require('../common/request')
const tracerVersion = require('../../../../../package.json').version

const BaseWriter = require('../common/writer')
const { AgentlessJSONEncoder } = require('../../encode/agentless-json')

/**
 * Writer for agentless APM span intake.
 * Sends spans directly to the Datadog intake endpoint without an agent.
 */
class AgentlessWriter extends BaseWriter {
  #apiKeyMissing = false

  /**
   * @param {object} options - Writer options
   * @param {URL} [options.url] - The intake URL. If not provided, constructed from site.
   * @param {string} [options.site='datadoghq.com'] - The Datadog site
   */
  constructor ({ url, site = 'datadoghq.com' }) {
    super({ url })
    this._encoder = new AgentlessJSONEncoder()

    if (!url) {
      try {
        this._url = new URL(`https://public-trace-http-intake.logs.${site}`)
      } catch (err) {
        log.error(
          'Invalid site value for agentless intake: %s. Cannot construct URL. Error: %s',
          site,
          err.message
        )
        this._url = null
      }
    }

    if (!getValueFromEnvSources('DD_API_KEY')) {
      this.#apiKeyMissing = true
      log.error(
        'DD_API_KEY is required for agentless span intake. ' +
        'Set the DD_API_KEY environment variable. Spans will not be sent.'
      )
    }
  }

  /**
   * Flushes the current trace. Since we flush after each trace, this sends
   * a single request.
   * @param {function} [done] - Callback when send completes
   */
  flush (done = () => {}) {
    if (!request.writable) {
      this._encoder.reset()
      done()
      return
    }

    const count = this._encoder.count()

    if (count === 0) {
      done()
      return
    }

    const payload = this._encoder.makePayload()

    if (payload.length === 0) {
      log.debug('Skipping send of empty payload')
      done()
      return
    }

    this._sendPayload(payload, count, done)
  }

  /**
   * Sends the encoded payload to the intake endpoint.
   * @param {Buffer} data - The encoded JSON payload
   * @param {number} count - Number of spans in the payload
   * @param {function} done - Callback when complete
   */
  _sendPayload (data, count, done) {
    if (!data || data.length === 0) {
      log.debug('Skipping send of empty payload')
      done()
      return
    }

    if (!this._url) {
      log.debug('Skipping send due to invalid URL configuration')
      done()
      return
    }

    const apiKey = getValueFromEnvSources('DD_API_KEY')
    if (!apiKey) {
      if (!this.#apiKeyMissing) {
        this.#apiKeyMissing = true
        log.error(
          'DD_API_KEY is required for agentless span intake. ' +
          'Set the DD_API_KEY environment variable. Spans will not be sent.'
        )
      }
      log.debug('Dropping %d span(s) due to missing DD_API_KEY', count)
      done()
      return
    }
    this.#apiKeyMissing = false

    const options = {
      path: '/v1/input',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'dd-api-key': apiKey,
        'Datadog-Meta-Lang': 'nodejs',
        'Datadog-Meta-Lang-Version': process.version,
        'Datadog-Meta-Lang-Interpreter': process.versions.bun ? 'JavaScriptCore' : 'v8',
        'Datadog-Meta-Tracer-Version': tracerVersion,
      },
      timeout: 15_000,
      url: this._url,
    }

    log.debug('Request to the agentless intake: %j', options)

    request(data, options, (err, res, statusCode) => {
      if (err) {
        this._logRequestError(err, statusCode, count)
        done()
        return
      }

      log.debug('Response from the agentless intake: %s', res)
      done()
    })
  }

  /**
   * Logs request errors with status-specific guidance.
   * @param {Error} err - The error object
   * @param {number} statusCode - HTTP status code (if available)
   * @param {number} count - Number of spans that were being sent
   */
  _logRequestError (err, statusCode, count) {
    if (statusCode === 401 || statusCode === 403) {
      log.error(
        'Authentication failed sending %d span(s) (status %s). Verify DD_API_KEY is valid.',
        count,
        statusCode
      )
    } else if (statusCode === 404) {
      log.error(
        'Span intake endpoint not found (status %s). Verify DD_SITE is correctly configured. %d span(s) dropped.',
        statusCode,
        count
      )
    } else if (statusCode === 429) {
      log.error(
        'Rate limited by span intake (status 429). %d span(s) dropped.',
        count
      )
    } else if (statusCode >= 500) {
      log.error(
        'Span intake server error (status %s). %d span(s) dropped. This may be transient.',
        statusCode,
        count
      )
    } else if (!statusCode) {
      log.error(
        'Network error sending %d span(s) to %s: %s',
        count,
        this._url?.hostname || 'unknown',
        err.message
      )
    } else {
      log.error(
        'Error sending agentless payload (status %s): %s. %d span(s) dropped.',
        statusCode,
        err.message,
        count
      )
    }
  }
}

module.exports = AgentlessWriter
