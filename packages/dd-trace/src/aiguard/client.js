'use strict'

const tracerVersion = require('../../../../package.json').version
const { AIGuardClientError } = require('./errors')
const { parseEvaluationResponse } = require('./evaluation')
const TAGS = require('./tags')

/**
 * Resolves the AI Guard host for a Datadog site.
 *
 * @param {string} site
 * @returns {string}
 */
function aiGuardHost (site) {
  return site.split('.').length === 2 ? `app.${site}` : site
}

/**
 * Sends a request to the AI Guard service.
 *
 * @param {object} body
 * @param {{ url: string, headers: Record<string, string>, timeout: number }} opts
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function executeRequest (body, opts) {
  const postData = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    ...opts.headers,
  }

  const response = await fetch(opts.url, {
    method: 'POST',
    headers,
    body: postData,
    signal: AbortSignal.timeout(opts.timeout),
  })

  const responseBody = await response.json()
  return {
    status: response.status,
    body: responseBody,
  }
}

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
    const endpoint = config.experimental.aiguard.endpoint || `https://${aiGuardHost(config.site)}/api/v2/ai-guard`
    this.#evaluateUrl = `${endpoint}/evaluate`
    this.#timeout = config.experimental.aiguard.timeout
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
