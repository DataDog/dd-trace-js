'use strict'

/**
 * Creates cold start trace spans from the require dependency tree.
 *
 * @param {object} tracer
 * @param {object|undefined} parentSpan
 * @param {string|undefined} functionName
 * @param {number} currentSpanStartTime
 * @param {number} minDuration - minimum duration in ms to include
 * @param {string} ignoreLibs - comma-separated list of libs to skip
 * @param {boolean} isColdStart
 * @param {Array} rootNodes - require tree root nodes
 */
function traceColdStart (tracer, parentSpan, functionName, currentSpanStartTime, minDuration, ignoreLibs, isColdStart, rootNodes) {
  if (!rootNodes || rootNodes.length === 0) return

  const ignoreSet = ignoreLibs ? ignoreLibs.split(',') : []
  const coldStartSpanStartTime = rootNodes[0].startTime
  const coldStartSpanEndTime = Math.min(rootNodes[rootNodes.length - 1].endTime, currentSpanStartTime)

  let targetParent = parentSpan
  if (isColdStart) {
    targetParent = createColdStartSpan(tracer, coldStartSpanStartTime, coldStartSpanEndTime, parentSpan, functionName)
  }

  for (const node of rootNodes) {
    traceTree(tracer, node, targetParent, minDuration, ignoreSet, functionName)
  }
}

function createColdStartSpan (tracer, startTime, endTime, parentSpan, functionName) {
  const options = {
    startTime,
    tags: {
      service: 'aws.lambda',
      operation_name: 'aws.lambda.require',
      resource_names: functionName,
      'resource.name': functionName,
    },
  }
  if (parentSpan) options.childOf = parentSpan
  const span = tracer.startSpan('aws.lambda.load', options)
  span.finish(endTime)
  return span
}

function coldStartSpanOperationName (filename) {
  if (filename.startsWith('/opt/')) return 'aws.lambda.require_layer'
  if (filename.startsWith('/var/runtime/')) return 'aws.lambda.require_runtime'
  if (filename.includes('/')) return 'aws.lambda.require'
  return 'aws.lambda.require_core_module'
}

function traceTree (tracer, node, parentSpan, minDuration, ignoreSet, functionName) {
  if (node.endTime - node.startTime < minDuration) return
  if (ignoreSet.includes(node.id)) return

  const opName = coldStartSpanOperationName(node.filename)
  const options = {
    startTime: node.startTime,
    tags: {
      service: 'aws.lambda',
      operation_name: opName,
      resource_names: node.id,
      'resource.name': node.id,
      filename: node.filename,
    },
  }
  if (parentSpan) options.childOf = parentSpan
  const span = tracer.startSpan(opName, options)

  if (node.endTime - node.startTime > minDuration && node.children) {
    for (const child of node.children) {
      traceTree(tracer, child, span, minDuration, ignoreSet, functionName)
    }
  }
  span.finish(node.endTime)
}

module.exports = {
  traceColdStart,
}
