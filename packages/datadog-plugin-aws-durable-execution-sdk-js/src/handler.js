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
    const span = ctx?.currentStore?.span
    const status = ctx?.result?.Status
    if (span && typeof status === 'string') {
      span.setTag('aws.durable.invocation_status', status.toLowerCase())
      // When the workflow suspends (status=PENDING), the SDK intentionally leaves
      // the suspended operations' DurablePromise pending — neither resolves nor
      // rejects them. Operation spans' asyncEnd therefore never fire, so we
      // finish them here so the trace processor can flush the trace.
      if (status === 'PENDING') finishOpenChildSpans(span)
    }
    super.finish(ctx)
  }
}

function finishOpenChildSpans (executeSpan) {
  const trace = executeSpan?._spanContext?._trace
  if (!trace?.started) return

  for (const span of trace.started) {
    if (span === executeSpan) continue
    if (span._integrationName !== AwsDurableExecutionSdkJsHandlerPlugin.id) continue
    if (span._duration === undefined) {
      span.finish()
    }
  }
}

module.exports = AwsDurableExecutionSdkJsHandlerPlugin
