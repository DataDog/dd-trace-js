'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AwsDurableExecutionSdkJsHandlerPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  bindStart (ctx) {
    const args = ctx.arguments || []
    const event = args[0]
    const durableExecutionMode = args[3]
    const handler = args[5]

    const meta = {
      'aws.durable.replayed': String(durableExecutionMode === 'ReplayMode'),
    }
    const arn = event?.DurableExecutionArn
    if (arn) {
      meta['aws.durable.execution_arn'] = arn
    }

    this.startSpan('aws.durable.execute', {
      resource: handler?.name,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    const status = ctx?.result?.Status
    if (span && typeof status === 'string') {
      span.setTag('aws.durable.invocation_status', status.toLowerCase())
    }

    // When the workflow suspends (status=PENDING), the SDK intentionally leaves the
    // suspended operations DurablePromise pending, neither resolves nor rejects them.
    // The operation span asyncEnd therefore never fires and the span stays open.
    if (span && status?.toUpperCase() === 'PENDING') {
      finishOpenChildSpans(span)
    }

    super.finish(ctx)
  }
}

/**
 * Finishes any open spans in the same trace as `executeSpan`, except the execute
 * span itself (the caller finishes that one). Used on suspension so the trace
 * processor can flush the invocation's trace.
 *
 * @param {object} executeSpan - The execute span (its trace contains all op spans
 *   created within this invocation).
 */
function finishOpenChildSpans (executeSpan) {
  const trace = executeSpan?._spanContext?._trace
  if (!trace?.started) return

  for (const span of trace.started) {
    if (span === executeSpan) continue
    if (span._duration === undefined) {
      span.finish()
    }
  }
}

module.exports = AwsDurableExecutionSdkJsHandlerPlugin
