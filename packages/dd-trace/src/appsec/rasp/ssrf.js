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
const { updateRaspRuleMatchMetricTags } = require('../telemetry')

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

  // Determine if we should collect the response body based on sampling rate and redirect URL
  ctx.shouldCollectBody = downstream.shouldSampleBody(req, outgoingUrl)

  const requestAddresses = downstream.extractRequestData(ctx)

  const ephemeral = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.run({ ephemeral }, req, raspRule)

  handleResult(result, req, store?.res, ctx.abortController, config, raspRule)

  downstream.incrementDownstreamAnalysisCount(req)
}

/**
 * Finalizes body collection for the response and triggers RASP analysis.
 * @param {{
 *   ctx: object,
 *   res: import('http').IncomingMessage,
 *   body: string|Buffer|null
 * }} payload event payload from the channel.
 */
function handleResponseFinish ({ ctx, res, body }) {
  // downstream response object
  if (!res) return

  const store = storage('legacy').getStore()
  const originatingRequest = store?.req
  if (!originatingRequest) return

  // Skip body analysis for redirect responses
  const evaluateBody = ctx.shouldCollectBody && !downstream.handleRedirectResponse(originatingRequest, res)
  const responseBody = evaluateBody ? body : null
  runResponseEvaluation(res, originatingRequest, responseBody)
}

/**
 * Evaluates the downstream response and records telemetry.
 * @param {import('http').IncomingMessage} res outgoing response object.
 * @param {import('http').IncomingMessage} req originating outgoing request.
 * @param {string|Buffer|null} responseBody collected downstream response body
 */
function runResponseEvaluation (res, req, responseBody) {
  const responseAddresses = downstream.extractResponseData(res, responseBody)

  if (!Object.keys(responseAddresses).length) return

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'response' }
  const result = waf.run({ ephemeral: responseAddresses }, req, raspRule)

  // TODO: this should be done in the waf functions directly instead of calling it everywhere
  const ruleTriggered = !!result?.events?.length

  if (ruleTriggered) {
    updateRaspRuleMatchMetricTags(req, raspRule, false, false)
  }
}

module.exports = { enable, disable }
