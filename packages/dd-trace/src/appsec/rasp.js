'use strict'

const { storage } = require('../../../datadog-core')
const web = require('./../plugins/util/web')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const { reportStackTrace } = require('./stack_trace')
const waf = require('./waf')
const { getBlockingAction, block } = require('./blocking')
const { channel } = require('dc-polyfill')

const startSetUncaughtExceptionCaptureCallback = channel('datadog:process:setUncaughtExceptionCaptureCallback:start')

class AbortError extends Error {
  constructor (req, res, blockingAction) {
    super('AbortError')
    this.name = 'AbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

function isAbortError (err) {
  return err instanceof AbortError || err.cause instanceof AbortError
}

function handleUncaughtExceptionMonitor (err, origin) {
  if (isAbortError(err)) {
    const { req, res, blockingAction } = err
    block(req, res, web.root(req), null, blockingAction)

    if (!process.hasUncaughtExceptionCaptureCallback()) {
      process.setUncaughtExceptionCaptureCallback(() => {
        process.setUncaughtExceptionCaptureCallback(null)
      })
    }
  }
}

const RULE_TYPES = {
  SSRF: 'ssrf'
}

let config, abortOnUncaughtException

let previousCallback, userDefinedCallback

function enable (_config) {
  config = _config
  httpClientRequestStart.subscribe(analyzeSsrf)

  process.on('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)
  abortOnUncaughtException = process.execArgv?.includes('--abort-on-uncaught-exception')

  if (abortOnUncaughtException) {
    process.on('unhandledRejection', function (err) {
      if (isAbortError(err)) {
        const { req, res, blockingAction } = err
        block(req, res, web.root(req), null, blockingAction)
      } else {
        const listeners = process.listeners('unhandledRejection')
        // do not force crash if there are more listeners
        if (listeners.length === 1) {
          // TODO check the --unhandled-rejections flag
          throw err
        }
      }
    })

    let appsecCallbackSetted = false
    startSetUncaughtExceptionCaptureCallback.subscribe(({ currentCallback, newCallback, abortController }) => {
      previousCallback = currentCallback
      if (appsecCallbackSetted) {
        userDefinedCallback = newCallback
        abortController.abort()
      }
    })

    if (process.hasUncaughtExceptionCaptureCallback()) {
      process.setUncaughtExceptionCaptureCallback(null)
      userDefinedCallback = previousCallback
    }

    const exceptionCaptureCallback = function (err) {
      if (!isAbortError(err)) {
        if (userDefinedCallback) {
          userDefinedCallback(err)
        } else {
          process.setUncaughtExceptionCaptureCallback(null)

          throw err // app will crash by customer app reasons
        }
      }
    }

    process.setUncaughtExceptionCaptureCallback(exceptionCaptureCallback)
    appsecCallbackSetted = true
  }
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
    if (rootSpan.context()._name === 'express.request') {
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
