'use strict'

const web = require('../../plugins/util/web')
const { setUncaughtExceptionCaptureCallbackStart } = require('../channels')
const { block } = require('../blocking')
const log = require('../../log')
const ssrf = require('./ssrf')
const sqli = require('./sql_injection')

const {
  setAbortOnUncaughtException,
  DatadogRaspAbortError
} = require('./utils')

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

function findDatadogRaspAbortError (err, deep = 10) {
  if (err instanceof DatadogRaspAbortError) {
    return err
  }

  if (err.cause && deep > 0) {
    return findDatadogRaspAbortError(err.cause, deep - 1)
  }
}

function handleUncaughtExceptionMonitor (err) {
  const abortError = findDatadogRaspAbortError(err)
  if (!abortError) return

  const { req, res, blockingAction } = abortError
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

function enable (config) {
  ssrf.enable(config)
  sqli.enable(config)

  process.on('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)

  const abortOnUncaughtException = process.execArgv?.includes('--abort-on-uncaught-exception')
  setAbortOnUncaughtException(abortOnUncaughtException)

  if (abortOnUncaughtException) {
    log.warn('The --abort-on-uncaught-exception flag is enabled. The RASP module will not block operations.')
  }
}

function disable () {
  ssrf.disable()
  sqli.disable()

  process.off('uncaughtExceptionMonitor', handleUncaughtExceptionMonitor)
}

module.exports = {
  enable,
  disable,
  handleUncaughtExceptionMonitor // exported only for testing purpose
}
