'use strict'

const { format } = require('url')
const {
  httpClientRequestStart,
  httpClientResponseData,
  httpClientResponseFinish
} = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const downstream = require('../downstream_requests')

// Store response state on ctx and res objects
const RESPONSE_STATE = Symbol('http.client.response.state')

let config

function enable (_config) {
  config = _config
  downstream.enable(_config)

  httpClientRequestStart.subscribe(analyzeSsrf)
  httpClientResponseData.subscribe(handleResponseData)
  httpClientResponseFinish.subscribe(handleResponseFinish)
}

function disable () {
  downstream.disable()

  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)
  if (httpClientResponseData.hasSubscribers) httpClientResponseData.unsubscribe(handleResponseData)
  if (httpClientResponseFinish.hasSubscribers) httpClientResponseFinish.unsubscribe(handleResponseFinish)
}

function analyzeSsrf (ctx) {
  const store = storage('legacy').getStore()
  const req = store?.req
  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri

  if (!req || !outgoingUrl) return

  // Determine if we should collect the response body based on sampling rate
  const includeBodies = downstream.shouldSampleBody(req)

  // Initialize state for tracking this request's response
  ctx[RESPONSE_STATE] = {
    req,
    includeBodies,
    chunks: includeBodies ? [] : null,
    done: false
  }

  const requestAddresses = downstream.extractRequestData(ctx)

  const ephemeral = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl,
    ...requestAddresses
  }

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'request' }

  const result = waf.run({ ephemeral }, req, raspRule)

  handleResult(result, req, store?.res, ctx.abortController, config, raspRule)

  // Track body analysis count if we're sampling the response body
  if (includeBodies) {
    downstream.incrementBodyAnalysisCount(req)
  }
}

function handleResponseData ({ ctx, chunk, res }) {
  if (!res || !chunk) return

  const state = ctx[RESPONSE_STATE]

  if (!state?.includeBodies || state?.done) return

  // Handle both string chunks (from setEncoding) and Buffer chunks
  if (typeof chunk === 'string') {
    state.chunks.push(chunk)
  } else if (Buffer.isBuffer(chunk)) {
    state.chunks.push(chunk)
  } else {
    // Handle Uint8Array or other array-like types
    state.chunks.push(Buffer.from(chunk))
  }
}

function handleResponseFinish ({ ctx, res }) {
  if (!res) return

  const state = ctx[RESPONSE_STATE]
  if (!state || state.done) return

  state.done = true

  // If we were collecting bodies and have no chunks, skip evaluation
  if (state.includeBodies && !state.chunks?.length) return

  // Combine collected chunks into a single body (or null if no chunks)
  let body = null
  if (state.chunks?.length) {
    const firstChunk = state.chunks[0]
    body = typeof firstChunk === 'string'
      ? state.chunks.join('')
      : Buffer.concat(state.chunks)
  }

  runResponseEvaluation(res, state.req, body)

  delete ctx[RESPONSE_STATE]
}

function runResponseEvaluation (res, req, responseBody) {
  const responseAddresses = downstream.extractResponseData(res, !!responseBody, responseBody)

  if (!Object.keys(responseAddresses).length) return

  downstream.addDownstreamRequestMetric(req)

  const raspRule = { type: RULE_TYPES.SSRF, variant: 'response' }
  const result = waf.run({ ephemeral: responseAddresses }, req, raspRule)

  const ruleTriggered = !!result?.events?.length

  if (ruleTriggered) {
    downstream.handleResponseTracing(req, raspRule)
  }
}

module.exports = { enable, disable }
