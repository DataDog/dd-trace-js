'use strict'

const web = require('../../plugins/util/web')
const {
  setUncaughtExceptionCaptureCallbackStart,
  expressMiddlewareError,
  fastifyMiddlewareError,
  routerMiddlewareError
} = require('../channels')
const { block, registerBlockDelegation, isBlocked } = require('../blocking')
const ssrf = require('./ssrf')
const sqli = require('./sql_injection')
const lfi = require('./lfi')
const cmdi = require('./command_injection')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')

const { DatadogRaspAbortError } = require('./utils')

function removeAllListeners (emitter, event) {
  const listeners = emitter.listeners(event)
  emitter.removeAllListeners(event)

  let cleaned = false
  return function () {
    if (cleaned === true) {
      return
    }
    cleaned = true

    for (const listener of listeners) {
      emitter.on(event, listener)
    }
  }
}

function findDatadogRaspAbortError (err, deep = 10) {
  if (err instanceof DatadogRaspAbortError) {
    return err
  }

  if (err?.cause && deep > 0) {
    return findDatadogRaspAbortError(err.cause, deep - 1)
  }
}

function handleUncaughtExceptionMonitor (error) {
  if (!blockOnDatadogRaspAbortError({ error, isTopLevel: true })) return

  if (process.hasUncaughtExceptionCaptureCallback()) {
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
  } else {
    const cleanUp = removeAllListeners(process, 'uncaughtException')
    const handler = () => {
      process.removeListener('uncaughtException', handler)
    }

    setTimeout(() => {
      process.removeListener('uncaughtException', handler)
      cleanUp()
    })

    process.on('uncaughtException', handler)
  }
}

function blockOnDatadogRaspAbortError ({ error, isTopLevel }) {
  const abortError = findDatadogRaspAbortError(error)
  if (!abortError) return false

  const { req, res, blockingAction, raspRule, ruleTriggered } = abortError
  if (!isBlocked(res)) {
    const blockFn = isTopLevel ? block : registerBlockDelegation
    const blocked = blockFn(req, res, web.root(req), null, blockingAction)
    if (ruleTriggered) {
      // block() returns a bool, and registerBlockDelegation() returns a promise
      // we use Promise.resolve() to handle both cases
      Promise.resolve(blocked).then(blocked => {
        // TODO: bug: this metric is not called when the raspAbortError is caught by user
        // or on subsequent blockDelegations
        updateRaspRuleMatchMetricTags(req, raspRule, true, blocked)
      })
    }
  }

  return true
}

function enable (config) {
  ssrf.enable(config)
  sqli.enable(config)
  lfi.enable(config)
  cmdi.enable(config)

  process.on('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)

  expressMiddlewareError.subscribe(blockOnDatadogRaspAbortError)
  fastifyMiddlewareError.subscribe(blockOnDatadogRaspAbortError)
  routerMiddlewareError.subscribe(blockOnDatadogRaspAbortError)
}

function disable () {
  ssrf.disable()
  sqli.disable()
  lfi.disable()
  cmdi.disable()

  process.off('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)

  expressMiddlewareError.unsubscribe(blockOnDatadogRaspAbortError)
  fastifyMiddlewareError.unsubscribe(blockOnDatadogRaspAbortError)
  routerMiddlewareError.unsubscribe(blockOnDatadogRaspAbortError)
}

module.exports = {
  enable,
  disable,
  handleUncaughtExceptionMonitor, // exported only for testing purpose
  blockOnDatadogRaspAbortError // exported only for testing purpose
}
