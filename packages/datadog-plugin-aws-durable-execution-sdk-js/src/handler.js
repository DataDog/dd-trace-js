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
    const handler = args[5]

    const meta = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'internal',
    }

    const arn = event?.DurableExecutionArn
    if (arn) {
      meta['aws.durable.execution_arn'] = arn
    }
    meta['aws.durable.replayed'] = String(event?.InitialExecutionState?.Operations?.length > 1)

    this.startSpan('aws.durable.execute', { resource: handler?.name, meta }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    const status = ctx?.result?.Status
    if (span && typeof status === 'string') {
      span.setTag('aws.durable.invocation_status', status.toLowerCase())
    }

    // When the workflow suspends (status=PENDING), the suspended op's DurablePromise
    // never settles, so op-span asyncEnd never fires. The op span — and every ancestor
    // that was awaiting it — stays open. The trace processor only flushes a trace when
    // every started span is finished, so without intervention the whole invocation's
    // trace (including ops that completed before the suspension) is never sent.
    // Finish any open siblings/descendants of the execute span so the trace flushes.
    if (span && status?.toUpperCase() === 'PENDING') {
      finishOpenChildSpans(span)
    }

    super.finish(ctx)
  }

  // The handler is async, so the normal completion path is asyncEnd. error fires
  // for sync throws and async rejections; in both cases we still need to finish
  // the span (default behavior just sets the error tag without finishing).
  error (ctxOrError) {
    super.error(ctxOrError)
    super.finish(ctxOrError)
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
