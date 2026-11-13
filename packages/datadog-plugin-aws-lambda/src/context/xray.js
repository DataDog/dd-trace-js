'use strict'

// Context primitives ported from datadog-lambda-js at da9fc3c0.
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const { fromTraceContext } = require('./span-context')

/**
 * @param {string} header AWS trace header.
 * @returns {{ traceId: string, parentId: string, sampled: string }|undefined}
 */
function parseAWSTraceHeader (header) {
  const [root, parent, sampling] = header.split(';')
  if (parent === undefined || sampling === undefined) return
  const [, traceId] = root.split('=')
  const [, parentId] = parent.split('=')
  const [, sampled] = sampling.split('=')
  if (traceId === undefined || parentId === undefined || sampled === undefined) return
  return { traceId, parentId, sampled }
}

/**
 * Extracts the Datadog context embedded by upstream Java instrumentation.
 * This remains an event parent, independently of the X-Ray merge setting.
 *
 * @param {string} header AWS trace header.
 * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
 */
function extractDatadogContext (header) {
  const context = parseAWSTraceHeader(header)
  if (!context) return null
  const parts = context.traceId.split('-')
  if (parts.length <= 2 || !parts[2].startsWith('00000000')) return null
  return fromTraceContext({
    traceId: BigInt('0x' + parts[2].slice(8)).toString(10),
    parentId: BigInt('0x' + context.parentId).toString(10),
    sampleMode: parseInt(context.sampled, 10),
    source: 'event',
  })
}

/** @returns {import('../../../dd-trace/src/opentracing/span_context')|null} */
function extractXrayContext () {
  const header = getEnvironmentVariable('_X_AMZN_TRACE_ID')
  if (header === undefined) return null
  const context = parseAWSTraceHeader(header)
  if (!context || context.parentId.length !== 16) return null
  const parts = context.traceId.split('-')
  if (parts.length < 3 || parts[2].length !== 24) return null
  try {
    return fromTraceContext({
      traceId: (BigInt('0x' + parts[2]) % 0x80_00_00_00_00_00_00_00n).toString(10),
      parentId: BigInt('0x' + context.parentId).toString(10),
      sampleMode: parseInt(context.sampled, 10) === 1 ? 2 : -1,
      source: 'xray',
    })
  } catch {
    return null
  }
}

module.exports = { parseAWSTraceHeader, extractDatadogContext, extractXrayContext }
