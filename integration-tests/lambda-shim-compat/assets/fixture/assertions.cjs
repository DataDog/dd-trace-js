'use strict'

const { isDeepStrictEqual } = require('node:util')

/**
 * Collect independent assertions so an existing failure cannot hide another broken contract.
 * @param {object} child
 * @param {object[]} records
 * @param {string} scenario
 * @param {{version: string, shimVersion: string}} metadata
 */
function inspect (child, records, scenario, metadata) {
  const failures = []
  const check = (id, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) failures.push({ id, actual: actual ?? null, expected })
  }
  const spans = records.flatMap(record => record.traces?.flat() || [])
  const roots = spans.filter(span => span.name === 'aws.lambda')
  const results = records.filter(record => record.compat === 'result')
  const inside = records.filter(record => record.compat === 'inside')
  const metrics = records.filter(record => record.m)
  const identity = records.filter(record => record.compat === 'identity')
  const count = scenario === 'warm-reject' ? 2 : 1
  const timeout = scenario.startsWith('timeout')
  const tracing = scenario !== 'metrics-only'

  check('process.exit', child.status, 0)
  check('identity.count', identity.length, 1)
  check('identity.gate', identity[0]?.gate, 'unset')
  check('identity.tracer', identity[0]?.tracerVersion, metadata.version)
  check('identity.shim', identity[0]?.shimVersion, metadata.shimVersion)
  check('results.count', results.length, count)
  check('handler.calls', inside.length, count)
  check('lambda.count', roots.length, tracing ? count : 0)
  check('spans.count', spans.length, tracing ? count * 2 : 0)
  check('lambda.owners', roots.every(span => span.meta.component !== 'aws-lambda' &&
    span.meta['_dd.integration'] === 'opentracing'), true)
  check('metrics.invocations', metrics.filter(m => m.m === 'aws.lambda.enhanced.invocations').length, count)
  check('metrics.custom', metrics.filter(m => m.m === 'compat.custom').length, count)
  if (scenario === 'repeat-wrap') {
    check('wrapper.identity', records.find(r => r.compat === 'repeat')?.same, true)
    if (roots.length === 2) {
      // If the known npm re-wrap defect occurs, pin its full topology, not merely "two spans".
      const outer = roots.find(span => BigInt(`0x${span.parent_id}`) === 0n)
      const inner = roots.find(span => span !== outer)
      check('repeat.topology', !!outer && inner?.trace_id === outer.trace_id &&
        inner?.parent_id === outer.span_id && outer.type === 'serverless' && outer.error === 0 &&
        outer.meta.request_id === inner.meta.request_id, true)
    }
  }
  for (let index = 0; index < count; index++) {
    const result = results[index]
    const root = roots.find(span => span.meta.request_id === `compat-request-${index}` &&
      BigInt(`0x${span.span_id}`).toString() === inside[index]?.span)
    const isError = ['throw', 'reject', 'callback-error', 'fail', 'stream-throw', 'stream-reject'].includes(scenario) ||
      (scenario === 'warm-reject' && index === 0)
    check(`result.${index}`, isError ? result?.error : result?.value,
      isError
        ? 'expected failure'
        : timeout
          ? 'timeout-observed'
          : scenario === 'stream'
            ? 'streamed'
            : { statusCode: 200, body: 'compatibility-ok' })
    if (['done', 'succeed', 'fail', 'artifact'].includes(scenario)) {
      check(`callbackWaits.${index}`, result?.callbackWaits, false)
    }
    if (!tracing) continue
    check(`active.${index}`, typeof inside[index]?.span, 'string')
    check(`root.${index}`, !!root, true)
    if (!root) continue // Missing roots are already failures; avoid throwing away other invocation checks.
    check(`type.${index}`, root.type, 'serverless')
    check(`owner.${index}`, root.meta.component === 'aws-lambda', false)
    check(`error.${index}`, root.error, isError || timeout ? 1 : 0)
    check(`timeout.${index}`, root.meta['error.type'] === 'Impending Timeout', timeout)
    const children = spans.filter(span => span.name === (timeout ? 'compat.unfinished' : 'compat.child') &&
      span.parent_id === root.span_id && span.trace_id === root.trace_id)
    check(`children.${index}`, children.length, 1)
    check(`child.error.${index}`, children[0]?.error, 0)
    check(`headers.${index}`, inside[index]?.headers['x-datadog-parent-id'], BigInt(`0x${root.span_id}`).toString())
    if (scenario === 'custom-config' || scenario === 'propagation') {
      // Compare semantic facts rather than random trace IDs, retaining the precise wrong-parent shape.
      check(`trace.extracted.${index}`, BigInt(`0x${root.trace_id}`) === 1234n, true)
      check(`parent.extracted.${index}`, BigInt(`0x${root.parent_id}`) === 5678n, true)
      check(`parent.isRoot.${index}`, BigInt(`0x${root.parent_id}`) === 0n, false)
    }
    if (scenario === 'custom-config') check(`payload.${index}`, root.meta['function.request.payload'], 'test')
  }
  return failures
}

module.exports = { inspect }
