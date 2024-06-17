'use strict'

const { storage } = require('../../../datadog-core')
const web = require('./../plugins/util/web')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const { reportStackTrace } = require('./stack_trace')
const waf = require('./waf')
const { getBlockingAction, block } = require('./blocking')

class AbortError extends Error {
  constructor (req, res, blockingAction) {
    super('AbortError')
    this.name = 'AbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

function handleUncaughtException (err) {
  // err.cause to wrap the error thrown by client request
  if (err instanceof AbortError || err.cause instanceof AbortError) {
    const { req, res, blockingAction } = err
    block(req, res, web.root(req), null, blockingAction)
  } else {
    throw err
  }
}

const RULE_TYPES = {
  SSRF: 'ssrf'
}

let config

function enable (_config) {
  config = _config
  httpClientRequestStart.subscribe(analyzeSsrf)

  process.on('uncaughtException', handleUncaughtException)
}

function disable () {
  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)

  process.off('uncaughtException', handleUncaughtException)
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
  handleResult(result, req, res, ctx.abortController)
}

function getGenerateStackTraceAction (actions) {
  return actions?.generate_stack
}

function handleResult (actions, req, res, abortController) {
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

  const blockingAction = getBlockingAction(actions)
  if (blockingAction && abortController) {
    const rootSpan = web.root(req)
    // Should block only in express
    if (rootSpan.context()._name === 'express.request') {
      const abortError = new AbortError(req, res, blockingAction)
      abortController.abort(abortError)

      // TODO Delete this if when support for node 16 is removed
      if (!abortController.signal.reason) {
        abortController.signal.reason = abortError
      }
    }
  }
}

module.exports = {
  enable,
  disable,
  handleResult
}
