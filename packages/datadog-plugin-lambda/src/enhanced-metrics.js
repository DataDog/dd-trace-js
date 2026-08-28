'use strict'

const { parseTagsFromARN } = require('./arn')
const { getSandboxInitTags } = require('./cold-start')

const ENHANCED_NAMESPACE = 'aws.lambda.enhanced'

function getRuntimeTag () {
  const v = process.version
  if (v.startsWith('v18')) return 'runtime:nodejs18.x'
  if (v.startsWith('v20')) return 'runtime:nodejs20.x'
  if (v.startsWith('v22')) return 'runtime:nodejs22.x'
  if (v.startsWith('v24')) return 'runtime:nodejs24.x'
  return null
}

/**
 * @param {object} [context] Lambda context
 * @returns {string[]}
 */
function getEnhancedMetricTags (context) {
  const tags = []
  if (context) {
    let arnTags = [`functionname:${context.functionName}`]
    if (context.invokedFunctionArn) {
      arnTags = parseTagsFromARN(context.invokedFunctionArn, context.functionVersion)
    }
    tags.push(...arnTags, `memorysize:${context.memoryLimitInMB}`)
  }
  tags.push(...getSandboxInitTags())

  const runtimeTag = getRuntimeTag()
  if (runtimeTag) tags.push(runtimeTag)

  return tags
}

/**
 * @param {object} dogstatsd - DogStatsD client
 * @param {string} metricName
 * @param {number} value
 * @param {object} [context]
 */
function sendEnhancedMetric (dogstatsd, metricName, value, context) {
  const tags = getEnhancedMetricTags(context)
  dogstatsd.distribution(`${ENHANCED_NAMESPACE}.${metricName}`, value, undefined, tags)
}

function incrementInvocations (dogstatsd, context) {
  sendEnhancedMetric(dogstatsd, 'invocations', 1, context)
}

function incrementErrors (dogstatsd, context) {
  sendEnhancedMetric(dogstatsd, 'errors', 1, context)
}

function incrementBatchItemFailures (dogstatsd, count, context) {
  sendEnhancedMetric(dogstatsd, 'batch_item_failures', count, context)
}

module.exports = {
  getEnhancedMetricTags,
  incrementInvocations,
  incrementErrors,
  incrementBatchItemFailures,
}
