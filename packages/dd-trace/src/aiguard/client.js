'use strict'

const { promisify } = require('node:util')

const tracerVersion = require('../../../../package.json').version
const { createAgents } = require('../exporters/common/agents')
const request = require('../exporters/common/request')
const { AIGuardClientError } = require('./errors')
const { parseEvaluationResponse } = require('./evaluation')
const TAGS = require('./tags')

// Evaluations can run concurrently on the application's request path.
const { httpAgent, httpsAgent } = createAgents(16)

/**
 * Resolves the AI Guard host for a Datadog site.
 *
 * @param {string} site
 */
function aiGuardHost (site) {
  return site.split('.').length === 2 ? `app.${site}` : site
}

/**
 * Sends a request to the AI Guard service.
 *
 * @param {object} body
 * @param {{ url: string, headers: Record<string, string|undefined>, timeout: number }} opts
 * @param {(error: Error|null, response?: { status: number, body: unknown }) => void} callback
 */
function requestEvaluation (body, opts, callback) {
  const postData = JSON.stringify(body)
  const url = new URL(opts.url)
  request(postData, {
    url: url.href,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
    timeout: opts.timeout,
    signal: AbortSignal.timeout(opts.timeout),
    retry: false,
    includeErrorResponseBody: true,
  }, (error, result, status) => {
    if (status === undefined) {
      callback(error || new Error('AI Guard request completed without a status'))
      return
    }

    let responseBody
    try {
      const responseText = error ? /** @type {Error & { responseBody?: string }} */ (error).responseBody : result
      if (typeof responseText !== 'string') throw new TypeError('AI Guard response body is missing')
      responseBody = JSON.parse(responseText)
    } catch (cause) {
      callback(cause)
      return
    }
    callback(null, { status, body: responseBody })
  })
}

/**
 * @typedef {(body: object, opts: {
 *   url: string,
 *   headers: Record<string, string|undefined>,
 *   timeout: number
 * }) => Promise<{ status: number, body: unknown }>} ExecuteRequest
 */
const executeRequest = /** @type {ExecuteRequest} */ (promisify(requestEvaluation))

class AIGuardClient {
  #headers
  #evaluateUrl
  #timeout

  /**
   * @param {import('../config/config-base')} config
   */
  constructor (config) {
    this.#headers = {
      'DD-API-KEY': config.DD_API_KEY,
      'DD-APPLICATION-KEY': config.DD_APP_KEY,
      'DD-AI-GUARD-VERSION': tracerVersion,
      'DD-AI-GUARD-SOURCE': 'SDK',
      'DD-AI-GUARD-LANGUAGE': 'nodejs',
    }
    const endpoint = config.aiguard.DD_AI_GUARD_ENDPOINT || `https://${aiGuardHost(config.site)}/api/v2/ai-guard`
    this.#evaluateUrl = `${endpoint}/evaluate`
    this.#timeout = config.aiguard.DD_AI_GUARD_TIMEOUT
  }

  /**
   * Evaluates messages and converts the service response to the internal evaluation contract.
   *
   * @param {import('../../../../index').aiguard.Message[]} messages
   * @param {{ service: string, env: string }} meta
   * @returns {Promise<NonNullable<ReturnType<typeof parseEvaluationResponse>>>}
   */
  evaluate (messages, meta) {
    const payload = {
      data: {
        attributes: {
          messages,
          meta,
        },
      },
    }
    return executeRequest(
      payload,
      { url: this.#evaluateUrl, headers: this.#headers, timeout: this.#timeout }
    )
      .then(response => this.#parseResponse(response))
      .catch(cause => {
        if (cause instanceof AIGuardClientError) throw cause

        throw new AIGuardClientError(`Unexpected error calling AI Guard service: ${cause.message}`, {
          cause,
          telemetryType: TAGS.ERROR_TYPE_CLIENT,
        })
      })
  }

  /**
   * Validates an AI Guard HTTP response.
   *
   * @param {{ status: number, body: unknown }} response
   * @returns {NonNullable<ReturnType<typeof parseEvaluationResponse>>}
   */
  #parseResponse (response) {
    if (response.status !== 200) {
      throw new AIGuardClientError(`AI Guard service call failed, status ${response.status}`, {
        errors: response.body?.errors,
        telemetryType: TAGS.ERROR_TYPE_STATUS,
      })
    }

    const evaluation = parseEvaluationResponse(response.body)
    if (!evaluation) {
      throw new AIGuardClientError(`AI Guard service returned unexpected response : ${response.body}`, {
        telemetryType: TAGS.ERROR_TYPE_RESPONSE,
      })
    }

    return evaluation
  }
}

module.exports = AIGuardClient
