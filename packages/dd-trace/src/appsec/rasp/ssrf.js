'use strict'

const { format } = require('url')
const { httpClientRequestStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

let config

function enable (_config) {
  config = _config
  httpClientRequestStart.subscribe(analyzeSsrf)
}

function disable () {
  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)
}

function analyzeSsrf (ctx) {
  const store = storage('legacy').getStore()
  const req = store?.req
  const outgoingUrl = (ctx.args.options?.uri && format(ctx.args.options.uri)) ?? ctx.args.uri

  if (!req || !outgoingUrl) return

  const persistent = {
    [addresses.HTTP_OUTGOING_URL]: outgoingUrl
  }

  const raspRule = { type: RULE_TYPES.SSRF }

  const result = waf.run({ persistent }, req, raspRule)

  const res = store?.res
  handleResult(result, req, res, ctx.abortController, config)
}

module.exports = { enable, disable }
