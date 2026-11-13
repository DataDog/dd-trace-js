'use strict'

const web = require('../../plugins/util/web')
const { getCallsiteFrames, reportStackTrace, canReportStackTrace } = require('../stack_trace')
const { getBlockingAction, registerBlockDelegation } = require('../blocking')
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
  SSRF: 'ssrf',
}

const ALLOWED_ROOTSPAN_NAMES = new Set([
  'express.request',
  'fastify.request',
])

/** @type {WeakMap<import('http').IncomingMessage, ((error: Error) => void) | undefined>} */
const requestsToBlockOnDetection = new WeakMap()

/**
 * @param {import('http').IncomingMessage} req
 * @param {(error: Error) => void} [ignoreError] Keeps the abort error of a blocked request out of the framework's
 *   request errors.
 */
function markToBlockOnDetection (req, ignoreError) {
  requestsToBlockOnDetection.set(req, ignoreError)
}

class DatadogRaspAbortError extends Error {
  constructor (req, res, blockingAction, raspRule, ruleTriggered) {
    super('DatadogRaspAbortError')
    this.name = 'DatadogRaspAbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
    this.raspRule = raspRule
    this.ruleTriggered = ruleTriggered

    // hide these props to not pollute app logs
    Object.defineProperties(this, {
      req: { enumerable: false },
      res: { enumerable: false },
    })
  }
}

function handleResult (result, req, res, abortController, config, raspRule) {
  const generateStackTraceAction = result?.actions?.generate_stack

  const {
    DD_APPSEC_STACK_TRACE_ENABLED: enabled,
    DD_APPSEC_MAX_STACK_TRACE_DEPTH: maxDepth,
    DD_APPSEC_MAX_STACK_TRACES: maxStackTraces,
  } = config.appsec

  const rootSpan = web.root(req)

  const ruleTriggered = !!result?.events?.length

  if (generateStackTraceAction && enabled && canReportStackTrace(rootSpan, maxStackTraces)) {
    const frames = getCallsiteFrames(maxDepth, handleResult)

    reportStackTrace(
      rootSpan,
      generateStackTraceAction.stack_id,
      frames
    )
  }

  if (abortController && !abortOnUncaughtException) {
    const blockingAction = getBlockingAction(result?.actions)
    const shouldBlockOnDetection = requestsToBlockOnDetection.has(req)

    if (blockingAction && (shouldBlockOnDetection || ALLOWED_ROOTSPAN_NAMES.has(rootSpan?.context?.()?._name))) {
      const abortError = new DatadogRaspAbortError(req, res, blockingAction, raspRule, ruleTriggered)

      if (shouldBlockOnDetection) {
        registerBlockDelegation(req, res, rootSpan, null, blockingAction).then(blocked => {
          if (ruleTriggered) {
            updateRaspRuleMatchMetricTags(req, raspRule, true, blocked)
          }
        })
        const ignoreError = requestsToBlockOnDetection.get(req)
        ignoreError?.(abortError)
      }

      abortController.abort(abortError)

      return
    }
  }

  if (ruleTriggered) {
    updateRaspRuleMatchMetricTags(req, raspRule, false, false)
  }
}

module.exports = {
  handleResult,
  markToBlockOnDetection,
  RULE_TYPES,
  DatadogRaspAbortError,
}
