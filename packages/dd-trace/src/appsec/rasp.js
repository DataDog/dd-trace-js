'use strict'

const { storage } = require('../../../datadog-core')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const waf = require('./waf')

function enable () {
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
  // TODO: Currently this is only monitoring, we should
  //     block the request if SSRF attempt and
  //     generate stack traces
  waf.run({ persistent }, req)
}

module.exports = {
  enable,
  disable
}
