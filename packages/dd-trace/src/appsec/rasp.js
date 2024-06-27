'use strict'

const { storage } = require('../../../datadog-core')
const web = require('./../plugins/util/web')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const { reportStackTrace } = require('./stack_trace')
const waf = require('./waf')
const { getBlockingAction, block } = require('./blocking')
const { channel } = require('dc-polyfill')
const setUncaughtExceptionCaptureCallbackStart = channel('datadog:process:setUncaughtExceptionCaptureCallback:start')
class AbortError extends Error {
  constructor (req, res, blockingAction) {
    super('AbortError')
    this.name = 'AbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

function handleUncaughtExceptionMonitor (err) {
  if (err instanceof AbortError || err.cause instanceof AbortError) {
    const { req, res, blockingAction } = err
    block(req, res, web.root(req), null, blockingAction)

    if (!process.hasUncaughtExceptionCaptureCallback()) {
      process.setUncaughtExceptionCaptureCallback(() => {
        process.setUncaughtExceptionCaptureCallback(null)
      })
    } else {
      let previousCb
      const cb = ({ currentCallback, abortController }) => {
        setUncaughtExceptionCaptureCallbackStart.unsubscribe(cb)
        if (!currentCallback) {
          abortController.abort()
          return
        }

        previousCb = currentCallback
      }

      setUncaughtExceptionCaptureCallbackStart.subscribe(cb)

      process.setUncaughtExceptionCaptureCallback(null)

      // For some reason, previous callback was defined before the instrumentation
      // We can not restore it, so we let the app decide
      if (previousCb) {
        process.setUncaughtExceptionCaptureCallback(() => {
          process.setUncaughtExceptionCaptureCallback(null)
          process.setUncaughtExceptionCaptureCallback(previousCb)
        })
      }
    }
  }
}

const RULE_TYPES = {
  SSRF: 'ssrf'
}

let config, abortOnUncaughtException

function enable (_config) {
  config = _config
  httpClientRequestStart.subscribe(analyzeSsrf)

  process.on('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)
  abortOnUncaughtException = process.execArgv?.includes('--abort-on-uncaught-exception')
}

function disable () {
  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)

  process.off('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)
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
    if (rootSpan.context()._name === 'express.request' && !abortOnUncaughtException) {
      const abortError = new AbortError(req, res, blockingAction)
      abortController.abort(abortError)

      // TODO Delete this when support for node 16 is removed
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
