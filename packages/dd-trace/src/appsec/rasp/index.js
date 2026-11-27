'use strict'

const { types } = require('node:util')

const web = require('../../plugins/util/web')
const {
  setUncaughtExceptionCaptureCallbackStart,
  expressMiddlewareError,
  fastifyMiddlewareError,
  routerMiddlewareError,
  nextRequestStart,
} = require('../channels')
const { block, registerBlockDelegation, isBlocked } = require('../blocking')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')
const ssrf = require('./ssrf')
const sqli = require('./sql_injection')
const lfi = require('./lfi')
const cmdi = require('./command_injection')

const { DatadogRaspAbortError, hasBlockingAbort, markToBlockOnDetection } = require('./utils')

// Same bound as the `cause` chain; libraries keep the abort error one or two errors deep.
const MAX_WRAPPING_ERRORS = 10

// Error.isError is available from Node.js 24, and util.types.isNativeError is deprecated from 24.2.0 (DEP0197).
const isError = Error.isError ?? types.isNativeError

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

/**
 * Finds the abort error of the request in the errors held by the own data properties of an error, for libraries that
 * throw their own error and keep the original one outside of `cause` (sequelize's `parent`, typeorm's `driverError`).
 * Only native errors are walked, and getters are not called.
 *
 * @param {unknown} error
 * @param {import('http').IncomingMessage} req
 * @returns {DatadogRaspAbortError | undefined}
 */
function findWrappedDatadogRaspAbortError (error, req) {
  if (!isError(error)) return

  const errors = [error]
  for (let i = 0; i < errors.length; i++) {
    for (const key of Reflect.ownKeys(errors[i])) {
      // Before Node.js 22, reading the descriptor of `stack` formats the stack trace and calls Error.prepareStackTrace.
      if (key === 'stack') continue

      const value = Reflect.getOwnPropertyDescriptor(errors[i], key)?.value
      if (!isError(value)) continue

      if (value instanceof DatadogRaspAbortError) {
        if (value.req === req) return value
      } else if (errors.length < MAX_WRAPPING_ERRORS) {
        errors.push(value)
      }
    }
  }
}

/**
 * Finds the abort error of the request in the error of a failed operation
 *
 * @param {unknown} error
 * @param {import('http').IncomingMessage} [failedRequest]
 * @returns {DatadogRaspAbortError | undefined}
 */
function resolveAbortError (error, failedRequest) {
  const directError = findDatadogRaspAbortError(error)
  if (directError) return directError

  if (!hasBlockingAbort(failedRequest)) return

  return findWrappedDatadogRaspAbortError(error, failedRequest)
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
    const handler = () => {}

    setTimeout(() => {
      process.removeListener('uncaughtException', handler)
      cleanUp()
    })

    process.once('uncaughtException', handler)
  }
}

function blockOnDatadogRaspAbortError ({ error, req: failedRequest, isTopLevel }) {
  const abortError = resolveAbortError(error, failedRequest)
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

function onNextRequestStart ({ req, ignoreError }) {
  markToBlockOnDetection(req, ignoreError)
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
  nextRequestStart.subscribe(onNextRequestStart)
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
  nextRequestStart.unsubscribe(onNextRequestStart)
}

module.exports = {
  enable,
  disable,
  handleUncaughtExceptionMonitor, // exported only for testing purpose
  blockOnDatadogRaspAbortError, // exported only for testing purpose
}
