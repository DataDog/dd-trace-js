'use strict'

const url = require('url')
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
  const store = storage.getStore()
  const req = store?.req
  const uri = (ctx.args.options?.uri && url.format(ctx.args.options?.uri)) ?? ctx.args.uri

  if (!req || !uri) return

  const persistent = {
    [addresses.HTTP_OUTGOING_URL]: uri
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.SSRF)

  const res = store?.res
  handleResult(result, req, res, ctx.abortController, config)
}

module.exports = { enable, disable }
