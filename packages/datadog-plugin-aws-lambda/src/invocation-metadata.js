'use strict'

const { VERSION } = require('../../../version')

/**
 * @param {Record<string, unknown>|undefined} context Lambda invocation context.
 * @param {import('./context/step-functions').StepFunctionContext|undefined} stepFunction Extractor's first-use context.
 * @param {string|undefined} shimVersion Shim-owned publish-time version, supplied through the private bridge.
 * @returns {Record<string, string|undefined>}
 */
function getInvocationTags (context, stepFunction, shimVersion) {
  let tags = {}
  if (context) {
    const arn = (context.invokedFunctionArn ?? '').toLowerCase()
    const parts = arn.split(':')
    tags = {
      function_arn: parts.length > 7 ? parts.slice(0, 7).join(':') : arn,
      function_version: parts.length > 7 ? parts[7] : '$LATEST',
      request_id: context.awsRequestId,
      resource_names: context.functionName,
      functionname: context.functionName?.toLowerCase(),
      dd_trace: VERSION,
    }
    // The npm version does not identify the published Lambda layer. The shim owns this value.
    if (shimVersion !== undefined) tags.datadog_lambda = shimVersion
  }
  return { ...tags, ...stepFunction }
}

module.exports = { getInvocationTags }
