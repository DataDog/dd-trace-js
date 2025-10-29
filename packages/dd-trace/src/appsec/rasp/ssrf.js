'use strict'

const { format } = require('url')
const {
  httpClientRequestStart,
  httpClientResponseFinish
} = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const downstream = require('../downstream_requests')

let config

function enable (_config) {
  config = _config
  downstream.enable(_config)

  httpClientRequestStart.subscribe(analyzeSsrf)
  httpClientResponseFinish.subscribe(handleResponseFinish)
}

function disable () {
  downstream.disable()

  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)
  if (httpClientResponseFinish.hasSubscribers) httpClientResponseFinish.unsubscribe(handleResponseFinish)
}

function analyzeSsrf (ctx) {
  const store = storage('legacy').getStore()
  const req = store?.req
  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri

  if (!req || !outgoingUrl) return

  // Determine if we should collect the response body based on sampling rate
  ctx.shouldCollectBody = downstream.shouldSampleBody(req)

  const requestAddresses = downstream.extractRequestData(ctx)

  const ephemeral = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.run({ ephemeral }, req, raspRule)

  handleResult(result, req, store?.res, ctx.abortController, config, raspRule)

  downstream.incrementDownstreamAnalysisCount(req)

  // Track body analysis count if we're sampling the response body
  if (ctx.shouldCollectBody) {
    downstream.incrementBodyAnalysisCount(req)
  }
}

/**
 * Finalizes body collection for the response and triggers RASP analysis.
 * @param {{
 *   res: import('http').IncomingMessage,
 *   body: string|Buffer|null
 * }} payload event payload from the channel.
 */
function handleResponseFinish ({ res, body }) {
  if (!res) return

  const store = storage('legacy').getStore()
  const req = store?.req
  if (!req) return

  runResponseEvaluation(res, req, body)
}

/**
 * Evaluates the downstream response and records telemetry.
 * @param {import('http').IncomingMessage} res outgoing response object.
 * @param {import('http').IncomingMessage} req originating inbound request.
 * @param {string|Buffer|null} responseBody collected downstream response body
 */
function runResponseEvaluation (res, req, responseBody) {
  const responseAddresses = downstream.extractResponseData(res, responseBody)

  if (!Object.keys(responseAddresses).length) return

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'response' }
  const result = waf.run({ ephemeral: responseAddresses }, req, raspRule)

  const ruleTriggered = !!result?.events?.length

  if (ruleTriggered) {
    downstream.handleResponseTracing(req, raspRule)
  }
}

module.exports = { enable, disable }
