'use strict'

const log = require('../../../dd-trace/src/log')

const statuses = new Set(['SUCCEEDED', 'FAILED', 'PENDING'])

/**
 * @param {Record<string, unknown>} event Lambda event.
 * @returns {Record<string, string>|undefined}
 */
function extractDurableFunctionContext (event) {
  const arn = event?.DurableExecutionArn
  if (typeof arn !== 'string') return
  const parsed = parseDurableExecutionArn(arn)
  if (!parsed) {
    log.debug('Failed to parse DurableExecutionArn: %s', arn)
    return
  }
  const context = {
    'aws.durable.execution_name': parsed.executionName,
    'aws.durable.execution_id': parsed.executionId,
  }
  const operations = event?.InitialExecutionState?.Operations
  if (Array.isArray(operations)) context['aws.durable.first_invocation'] = String(operations.length === 1)
  return context
}

/**
 * @param {Record<string, unknown>} event Lambda event.
 * @param {unknown} result Handler result.
 */
function extractDurableExecutionStatus (event, result) {
  if (typeof event?.DurableExecutionArn !== 'string') return
  const status = result?.Status
  if (typeof status === 'string' && statuses.has(status)) return status
}

/**
 * @param {string} arn Durable execution ARN.
 * @returns {{ executionName: string, executionId: string }|undefined}
 */
function parseDurableExecutionArn (arn) {
  const match = /\/durable-execution\/([^/]+)\/([^/]+)$/.exec(arn)
  if (match) return { executionName: match[1], executionId: match[2] }
}

module.exports = { extractDurableFunctionContext, extractDurableExecutionStatus, parseDurableExecutionArn }
