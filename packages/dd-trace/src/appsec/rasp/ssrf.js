'use strict'

const { format } = require('url')
const {
  httpClientRequestStart,
  httpClientRequestError,
  httpClientRequestFinish,
  httpClientResponseStart,
  httpClientResponseFinish,
} = require('../channels')
const addresses = require('../addresses')
const web = require('../../plugins/util/web')
const { getActiveRequest } = require('../store')
const waf = require('../waf')
const { isEmpty } = require('../../util')
const downstream = require('../downstream_requests')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')
const { RULE_TYPES, handleResult } = require('./utils')

let config

function enable (_config) {
  config = _config
  downstream.enable(_config)

  httpClientRequestFinish.subscribe(handleRequestFinish)
  httpClientRequestError.subscribe(handleRequestError)
  httpClientRequestStart.subscribe(analyzeSsrf)
  httpClientResponseStart.subscribe(planResponseBodyCollection)
  httpClientResponseFinish.subscribe(handleResponseFinish)
}

function disable () {
  downstream.disable()

  httpClientRequestFinish.unsubscribe(handleRequestFinish)
  httpClientRequestError.unsubscribe(handleRequestError)
  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)
  if (httpClientResponseStart.hasSubscribers) httpClientResponseStart.unsubscribe(planResponseBodyCollection)
  if (httpClientResponseFinish.hasSubscribers) httpClientResponseFinish.unsubscribe(handleResponseFinish)
}

function analyzeSsrf (ctx) {
  const req = getActiveRequest()
  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri

  if (!req || !outgoingUrl) return

  const requestAddresses = downstream.extractRequestData(ctx)

  const subcontextData = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses,
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.runSubContext(subcontextData, raspRule, ctx)

  handleResult(result, req, web.getContext(req)?.res, ctx.abortController, config, raspRule)

  downstream.incrementDownstreamAnalysisCount(req)
}

/**
 * Evaluates redirects before the next hop, or plans response body capture.
 * @param {{ ctx: object, res: import('http').IncomingMessage }} payload channel payload.
 */
function planResponseBodyCollection ({ ctx, res }) {
  const originatingRequest = waf.getRequest(ctx)
  if (!originatingRequest || !res) return

  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    // Record the redirect before application code can start the next hop.
    ctx.ssrfResponseEvaluated = true
    runResponseEvaluation(res, originatingRequest, null, ctx)
    return
  }

  downstream.planResponseBodyCollection(originatingRequest, res, ctx)
}

/** @param {{ error?: Error, wafSubcontext?: import('../waf/waf_context_wrapper') }} ctx HTTP request context. */
function handleRequestError (ctx) {
  // The error channel also publishes timeouts without an error; those can still receive a response.
  if (ctx.error) waf.disposeSubContext(ctx)
}

/**
 * @param {import('../waf').SubcontextState & { req?: import('http').ClientRequest,
 *   res?: import('http').IncomingMessage }} ctx HTTP request context.
 */
function handleRequestFinish (ctx) {
  // Ordinary responses still need their response-finish evaluation, including truncated bodies.
  if (!waf.getRequest(ctx) || (ctx.res && !ctx.res.upgrade)) return
  // Request finish is emitted only once and can precede a response after a timeout.
  if (!ctx.res && ctx.req && !ctx.req.destroyed) {
    ctx.req.once('close', () => handleRequestFinish(ctx))
    return
  }
  waf.disposeSubContext(ctx)
}

/**
 * Finalizes body collection for the response and triggers RASP analysis.
 * @param {object} params event payload from the channel.
 * @param {object} params.ctx instrumentation context.
 * @param {import('http').IncomingMessage} params.res downstream response.
 * @param {string|Buffer|null} params.body collected body.
 */
function handleResponseFinish ({ ctx, res, body }) {
  const req = waf.getRequest(ctx)
  if (!req) return

  try {
    if (!res || ctx.ssrfResponseEvaluated) return
    const responseBody = ctx.shouldCollectBody ? body : null
    runResponseEvaluation(res, req, responseBody, ctx)
  } finally {
    waf.disposeSubContext(ctx)
  }
}

/**
 * Evaluates the downstream response and records telemetry.
 * @param {import('http').IncomingMessage} res incoming response from downstream service.
 * @param {import('http').IncomingMessage} req originating request.
 * @param {string|Buffer|null} responseBody collected downstream response body.
 * @param {object} ctx - Outgoing HTTP instrumentation context.
 */
function runResponseEvaluation (res, req, responseBody, ctx) {
  const responseAddresses = downstream.extractResponseData(res, responseBody)

  if (isEmpty(responseAddresses)) return

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'response' }
  const result = waf.runSubContext(responseAddresses, raspRule, ctx)

  // TODO: this should be done in the waf functions directly instead of calling it everywhere
  const ruleTriggered = !!result?.events?.length

  if (ruleTriggered) {
    updateRaspRuleMatchMetricTags(req, raspRule, false, false)
  }
}

module.exports = { enable, disable }
