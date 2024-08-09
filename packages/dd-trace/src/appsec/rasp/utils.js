'use strict'

const web = require('../../plugins/util/web')
const { reportStackTrace } = require('../stack_trace')
const { getBlockingAction } = require('../blocking')

let abortOnUncaughtException = false

const RULE_TYPES = {
  SSRF: 'ssrf',
  SQL_INJECTION: 'sql_injection'
}

class DatadogRaspAbortError extends Error {
  constructor (req, res, blockingAction) {
    super('DatadogRaspAbortError')
    this.name = 'DatadogRaspAbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

function getGenerateStackTraceAction (actions) {
  return actions?.generate_stack
}

function handleResult (actions, req, res, abortController, config) {
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

  if (!abortController || abortOnUncaughtException) return

  const blockingAction = getBlockingAction(actions)
  if (blockingAction) {
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

function setAbortOnUncaughtException (newAbortOnUncaughtException) {
  abortOnUncaughtException = newAbortOnUncaughtException
}

module.exports = {
  handleResult,
  setAbortOnUncaughtException,
  RULE_TYPES,
  DatadogRaspAbortError
}
