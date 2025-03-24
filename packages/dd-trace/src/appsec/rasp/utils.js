'use strict'

const web = require('../../plugins/util/web')
const { getCallsiteFrames, reportStackTrace, canReportStackTrace } = require('../stack_trace')
const { getBlockingAction } = require('../blocking')
const log = require('../../log')
const { updateRaspRuleMatchMetricTags } = require('../telemetry')

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
  constructor (req, res, blockingAction, raspRule) {
    super('DatadogRaspAbortError')
    this.name = 'DatadogRaspAbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
    this.raspRule = raspRule
  }
}

function handleResult (actions, req, res, abortController, config, raspRule) {
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

  if (abortController && !abortOnUncaughtException) {
    const blockingAction = getBlockingAction(actions)

    if (blockingAction) {
      // Should block only in express
      if (rootSpan?.context()._name === 'express.request') {
        const abortError = new DatadogRaspAbortError(req, res, blockingAction, raspRule)
        abortController.abort(abortError)

        // TODO Delete this when support for node 16 is removed
        if (!abortController.signal.reason) {
          abortController.signal.reason = abortError
        }
        return
      }
    }
  }

  updateRaspRuleMatchMetricTags(req, raspRule, false, false)
}

module.exports = {
  handleResult,
  RULE_TYPES,
  DatadogRaspAbortError
}
