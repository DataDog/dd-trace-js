'use strict'

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
  const url = ctx.args.uri

  if (!req || !url) return

  const persistent = {
    [addresses.HTTP_OUTGOING_URL]: url
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.SSRF)

  const res = store?.res
  handleResult(result, req, res, ctx.abortController, config)
}

module.exports = { enable, disable }
