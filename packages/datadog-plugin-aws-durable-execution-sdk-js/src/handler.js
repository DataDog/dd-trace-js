'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { saveTraceContextCheckpointIfUpdated } = require('./trace-checkpoint')

// Termination reasons that indicate the execution is suspending rather than exiting permanently.
// Sourced from (`@aws/durable-execution-sdk-js`'s termination-manager/types.ts).
const PENDING_TERMINATION_REASONS = new Set([
  'OPERATION_TERMINATED',
  'RETRY_SCHEDULED',
  'RETRY_INTERRUPTED_STEP',
  'WAIT_SCHEDULED',
  'CALLBACK_PENDING',
  'CUSTOM',
])

const DEFAULT_TERMINATION_REASON = 'OPERATION_TERMINATED'

// Published by the instrumentation when the SDK's terminationManager.terminate() is called.
// The instrumentation owns the wrapping; this plugin only reacts.
const TERMINATE_CHANNEL = 'apm:aws-durable-execution-sdk-js:terminate'

class AwsDurableExecutionSdkJsHandlerPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  constructor (...args) {
    super(...args)
    // Gate the subscription on the feature flag: the instrumentation only wraps terminate() while
    // this channel has subscribers, so not subscribing keeps the wrapping off entirely.
    if (this._tracerConfig.DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED) {
      this.addSub(TERMINATE_CHANNEL, ctx => this.#onTerminate(ctx))
    }
  }

  bindStart (ctx) {
    const args = ctx.arguments || []
    const event = args[0]
    const durableExecutionMode = args[3]
    const handler = args[5]

    const meta = {
      'aws.durable.replayed': durableExecutionMode === 'ReplayMode' ? 'true' : 'false',
    }
    const arn = event?.DurableExecutionArn
    if (arn) {
      meta['aws.durable.execution_arn'] = arn
    }

    this.startSpan(this.operationName(), {
      resource: handler?.name,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  // Fired (synchronously, before the SDK's terminate() runs) when the execution suspends. On a
  // PENDING reason we persist the current trace context as a `_datadog` checkpoint, which
  // subsequent invocations consume to extract the parent trace context. `ctx` is the shared
  // withDurableExecution context: bindStart put the execute span on it, and the instrumentation
  // put the captured durableContext and termination reason on it.
  #onTerminate (ctx) {
    const reason = ctx.terminationReason ?? DEFAULT_TERMINATION_REASON
    if (!PENDING_TERMINATION_REASONS.has(reason)) return
    void maybeSaveCheckpoint(this.tracer, ctx)
  }

  asyncEnd (ctx) {
    const span = ctx?.currentStore?.span
    const status = ctx?.result?.Status
    if (span && typeof status === 'string') {
      span.setTag('aws.durable.invocation_status', status.toLowerCase())
    }
    // Operation child spans rely on user code awaiting the returned DurablePromise to settle;
    // suspended (PENDING) ops never settle, and fire-and-forget ops on terminal handler exits
    // are never awaited at all. Finish any still-open owned children so the trace can flush.
    if (span) finishOpenChildSpans(span)
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

// Save state is kept on the shared `ctx` so repeated terminate() calls within one execution
// save at most once. The execute span is also the anchor we propagate, so its span id is the
// `firstExecutionSpanId` passed downstream.
function maybeSaveCheckpoint (tracer, ctx) {
  if (ctx.checkpointSaved || ctx.checkpointSavePromise) return ctx.checkpointSavePromise

  const span = ctx.currentStore?.span
  const durableContext = ctx.durableContext
  if (!span || !durableContext) return

  ctx.checkpointSavePromise = saveTraceContextCheckpointIfUpdated(
    tracer,
    span,
    durableContext,
    span.context?.()?.toSpanId?.(),
    ctx.arguments?.[0],
    /* istanbul ignore next: defense-in-depth — saveTraceContextCheckpointIfUpdated catches
       internally and never rejects, so this handler is unreachable in practice */
  ).catch(() => {
    // Best-effort — never break customer workloads.
  }).finally(() => {
    ctx.checkpointSaved = true
    ctx.checkpointSavePromise = undefined
  })

  return ctx.checkpointSavePromise
}

module.exports = AwsDurableExecutionSdkJsHandlerPlugin
