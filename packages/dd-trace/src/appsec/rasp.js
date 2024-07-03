'use strict'

const { storage } = require('../../../datadog-core')
const web = require('./../plugins/util/web')
const addresses = require('./addresses')
const { httpClientRequestStart, setUncaughtExceptionCaptureCallbackStart } = require('./channels')
const { reportStackTrace } = require('./stack_trace')
const waf = require('./waf')
const { getBlockingAction, block } = require('./blocking')

class DatadogRaspAbortError extends Error {
  constructor (req, res, blockingAction) {
    super('DatadogRaspAbortError')
    this.name = 'DatadogRaspAbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

const RULE_TYPES = {
  SSRF: 'ssrf'
}

let config, abortOnUncaughtException

function removeAllListeners (emitter, event) {
  const listeners = emitter.listeners(event)
  emitter.removeAllListeners(event)

  let cleaned = false
  return function () {
    if (cleaned === true) {
      return
    }
    cleaned = true

    for (let i = 0; i < listeners.length; ++i) {
      emitter.on(event, listeners[i])
    }
  }
}

function handleUncaughtExceptionMonitor (err) {
  if (err instanceof DatadogRaspAbortError || err.cause instanceof DatadogRaspAbortError) {
    const { req, res, blockingAction } = err
    block(req, res, web.root(req), null, blockingAction)

    if (!process.hasUncaughtExceptionCaptureCallback()) {
      const cleanUp = removeAllListeners(process, 'uncaughtException')
      const handler = () => {
        process.removeListener('uncaughtException', handler)
      }

      setTimeout(() => {
        process.removeListener('uncaughtException', handler)
        cleanUp()
      })

      process.on('uncaughtException', handler)
    } else {
      // uncaughtException event is not executed when hasUncaughtExceptionCaptureCallback is true
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
  if (blockingAction && abortController && !abortOnUncaughtException) {
    const rootSpan = web.root(req)
    // Should block only in express
    if (rootSpan?.context()._name === 'express.request') {
      const abortError = new DatadogRaspAbortError(req, res, blockingAction)
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
