'use strict'

const { storage } = require('../../../datadog-core')
const web = require('./../plugins/util/web')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const { reportStackTrace } = require('./stack_trace')
const waf = require('./waf')

const RULE_TYPES = {
  SSRF: 'ssrf'
}

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
  // TODO: Currently this is only monitoring, we should
  //     block the request if SSRF attempt
  const result = waf.run({ persistent }, req, RULE_TYPES.SSRF)
  handleResult(result, req)
}

function getGenerateStackTraceAction (actions) {
  return actions?.generate_stack
}

function handleResult (actions, req) {
  const generateStackTraceAction = getGenerateStackTraceAction(actions)
  if (generateStackTraceAction && config.appsec.stackTrace.enabled) {
    const rootSpan = web.root(req)
    reportStackTrace(
      rootSpan,
      generateStackTraceAction.stack_id,
      config.appsec.stackTrace.maxDepth,
      config.appsec.stackTrace.maxStackTraces
    )
  }
}

module.exports = {
  enable,
  disable,
  handleResult
}
