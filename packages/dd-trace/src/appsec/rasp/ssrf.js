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
const { isEmpty } = require('../../util')
const downstream = require('../downstream_requests')
const Reporter = require('../reporter')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')
const { RULE_TYPES, handleResult } = require('./utils')

const firstRedirects = new WeakMap()
const redirectTags = ['appsec.api.redirection.move_target', 'api.security.redirection.move_target']

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

  const subcontextData = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses,
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.runSubContext(subcontextData, raspRule, ctx)

  reportRedirect(result, req)

  handleResult(result, req, web.getContext(req)?.res, ctx.abortController, config, raspRule)

  downstream.incrementDownstreamAnalysisCount(req)
}

/**
 * Channel handler: plans downstream response body capture once response headers are available.
 * @param {{ ctx: object, res: import('http').IncomingMessage }} payload channel payload.
 */
function planResponseBodyCollection ({ ctx, res }) {
  const originatingRequest = waf.getRequest(ctx)
  if (!originatingRequest || !res) return

  downstream.planResponseBodyCollection(originatingRequest, res, ctx)
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
    if (!res) return
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
  reportRedirect(result, req)

  // TODO: this should be done in the waf functions directly instead of calling it everywhere
  const ruleTriggered = !!result?.events?.length

  if (ruleTriggered) {
    updateRaspRuleMatchMetricTags(req, raspRule, false, false)
  }
}

/**
 * @param {object} result WAF evaluation result.
 * @param {object} req Originating incoming request.
 */
function reportRedirect (result, req) {
  if (!result?.attributes) return

  for (const tag of redirectTags) {
    if (!Object.hasOwn(result.attributes, tag)) continue
    if (firstRedirects.has(req)) {
      // WAF reporting updates attributes; retain this request's first SSRF redirect target.
      Reporter.reportAttributes({ [tag]: firstRedirects.get(req) }, req)
    } else {
      firstRedirects.set(req, result.attributes[tag])
    }
  }
}

module.exports = { enable, disable }
