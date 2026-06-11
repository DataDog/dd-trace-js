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

    this.#installTerminationCheckpointHook(ctx, event)

    return ctx.currentStore
  }

  // Wrap the user handler so we can capture the SDK's DurableContext, and
  // install a hook on the termination manager so that when the execution
  // suspends (PENDING) we persist the current trace context as a `_datadog`
  // checkpoint, which subsequent invocations consume to extract the parent
  // trace context.
  #installTerminationCheckpointHook (ctx, event) {
    if (!this._tracerConfig.DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED) return

    const args = ctx.arguments || []
    if (args.length < 6 || typeof args[5] !== 'function') return

    const executionContext = args[2]
    const terminationManager = executionContext?.terminationManager
    if (typeof terminationManager?.terminate !== 'function') return

    const span = ctx.currentStore?.span
    if (!span) return

    const state = {
      durableContext: undefined,
      firstExecutionSpanId: span.context?.()?.toSpanId?.(),
      invocationEvent: event,
      savePromise: undefined,
      saved: false,
      span,
      tracer: this.tracer,
    }

    const originalHandler = args[5]
    args[5] = function (...handlerArgs) {
      state.durableContext = handlerArgs[1]
      return originalHandler.apply(this, handlerArgs)
    }

    const originalTerminate = terminationManager.terminate
    terminationManager.terminate = function (...terminateArgs) {
      const reason = terminateArgs[0]?.reason ?? DEFAULT_TERMINATION_REASON
      if (PENDING_TERMINATION_REASONS.has(reason)) {
        // Must enqueue checkpoint updates before the checkpoint manager flips to terminating.
        void maybeSaveCheckpoint(state)
      }
      return originalTerminate.apply(this, terminateArgs)
    }
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

function maybeSaveCheckpoint (state) {
  if (state.saved || state.savePromise) return state.savePromise
  if (!state.tracer || !state.span || !state.durableContext) return

  state.savePromise = saveTraceContextCheckpointIfUpdated(
    state.tracer,
    state.span,
    state.durableContext,
    state.firstExecutionSpanId,
    state.invocationEvent,
    /* istanbul ignore next: defense-in-depth — saveTraceContextCheckpointIfUpdated catches
       internally and never rejects, so this handler is unreachable in practice */
  ).catch(() => {
    // Best-effort — never break customer workloads.
  }).finally(() => {
    state.saved = true
    state.savePromise = undefined
  })

  return state.savePromise
}

module.exports = AwsDurableExecutionSdkJsHandlerPlugin
