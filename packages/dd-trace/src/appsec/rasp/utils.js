'use strict'

const web = require('../../plugins/util/web')
const { getCallsiteFrames, reportStackTrace, canReportStackTrace } = require('../stack_trace')
const { getBlockingAction } = require('../blocking')
const log = require('../../log')

const abortOnUncaughtException = process.execArgv?.includes('--abort-on-uncaught-exception')

if (abortOnUncaughtException) {
  log.warn('[ASM] The --abort-on-uncaught-exception flag is enabled. The RASP module will not block operations.')
}

const RULE_TYPES = {
  COMMAND_INJECTION: 'command_injection',
  LFI: 'lfi',
  SQL_INJECTION: 'sql_injection',
  SSRF: 'ssrf'
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

function handleResult (actions, req, res, abortController, config) {
  const generateStackTraceAction = actions?.generate_stack

  const { enabled, maxDepth, maxStackTraces } = config.appsec.stackTrace

  const rootSpan = web.root(req)

  if (generateStackTraceAction && enabled && canReportStackTrace(rootSpan, maxStackTraces)) {
    const frames = getCallsiteFrames(maxDepth)

    reportStackTrace(
      rootSpan,
      generateStackTraceAction.stack_id,
      frames
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

module.exports = {
  handleResult,
  RULE_TYPES,
  DatadogRaspAbortError
}
