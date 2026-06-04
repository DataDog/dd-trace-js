'use strict'

const { format } = require('url')
const {
  httpClientRequestStart,
  httpClientResponseStart,
  httpClientResponseFinish,
} = require('../channels')
const addresses = require('../addresses')
const web = require('../../plugins/util/web')
const { getActiveRequest } = require('../store')
const waf = require('../waf')
const downstream = require('../downstream_requests')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')
const { RULE_TYPES, handleResult } = require('./utils')

let config

function enable (_config) {
  config = _config
  downstream.enable(_config)

  httpClientRequestStart.subscribe(analyzeSsrf)
  httpClientResponseStart.subscribe(planResponseBodyCollection)
  httpClientResponseFinish.subscribe(handleResponseFinish)
}

function disable () {
  downstream.disable()

  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)
  if (httpClientResponseStart.hasSubscribers) httpClientResponseStart.unsubscribe(planResponseBodyCollection)
  if (httpClientResponseFinish.hasSubscribers) httpClientResponseFinish.unsubscribe(handleResponseFinish)
}

function analyzeSsrf (ctx) {
  const req = getActiveRequest()
  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri

  if (!req || !outgoingUrl) return

  const requestAddresses = downstream.extractRequestData(ctx)

  const ephemeral = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses,
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.run({ ephemeral }, req, raspRule)

  handleResult(result, req, web.getContext(req)?.res, ctx.abortController, config, raspRule)

  downstream.incrementDownstreamAnalysisCount(req)
}

/**
 * Channel handler: plans downstream response body capture once response headers are available.
 * @param {{ ctx: object, res: import('http').IncomingMessage }} payload channel payload.
 */
function planResponseBodyCollection ({ ctx, res }) {
  const originatingRequest = getActiveRequest()
  if (!originatingRequest || !res) return

  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri
  if (!outgoingUrl) return

  downstream.planResponseBodyCollection(originatingRequest, outgoingUrl, res, ctx)
}

/**
 * Finalizes body collection for the response and triggers RASP analysis.
 * @param {object} params event payload from the channel.
 * @param {object} params.ctx instrumentation context.
 * @param {import('http').IncomingMessage} params.res downstream response.
 * @param {string|Buffer|null} params.body collected body.
 */
function handleResponseFinish ({ ctx, res, body }) {
  // downstream response object
  if (!res) return

  const originatingRequest = getActiveRequest()
  if (!originatingRequest) return

  const responseBody = ctx.shouldCollectBody ? body : null
  runResponseEvaluation(res, originatingRequest, responseBody)
}

/**
 * Evaluates the downstream response and records telemetry.
 * @param {import('http').IncomingMessage} res incoming response from downstream service.
 * @param {import('http').IncomingMessage} req originating request.
 * @param {string|Buffer|null} responseBody collected downstream response body.
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
