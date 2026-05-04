'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { maybeSaveTraceContextCheckpoint } = require('./trace-checkpoint')

// Non-pending termination reasons where we should NOT save a checkpoint, since the execution is not expected to resume.
const NON_PENDING_TERMINATION_REASONS = new Set([
  'CHECKPOINT_FAILED',
  'SERDES_FAILED',
  'CONTEXT_VALIDATION_ERROR',
])

const kTerminationHookInstalled = Symbol('dd-trace:aws-durable-execution-sdk-js:termination-hook-installed')

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

    this.startSpan('aws.durable.execute', {
      resource: handler?.name || 'aws.durable.execute',
      meta,
    }, ctx)

    // Wrap the user handler so we can capture the DurableContext.
    // _datadog checkpoints are saved only from the termination hook path,
    // i.e. only when we expect follow-up invocations.
    // runHandler signature: (event, context, executionContext, mode, checkpointToken, handler)
    if (args.length >= 6 && typeof handler === 'function') {
      const originalHandler = handler
      const span = ctx.currentStore?.span
      const tracer = this._tracer
      // Use aws.durable.execute as the cross-invocation linkage anchor.
      const checkpointAnchorSpanId = _getSpanId(span)
      const checkpointState = {
        durableContext: undefined,
        checkpointAnchorSpanId,
        invocationEvent: event,
        savePromise: null,
        saved: false,
        span,
        tracer,
      }

      _installTerminationCheckpointHook(args[2], checkpointState)

      args[5] = async function (...handlerArgs) {
        checkpointState.durableContext = handlerArgs[1]
        return originalHandler.apply(this, handlerArgs)
      }
    }

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

/**
 * Return the span_id of aws.durable.execute.
 * @param {object} span
 * @returns {string | undefined}
 */
function _getSpanId (span) {
  try {
    const spanId = span?.context?.()?._spanId
    if (spanId) return spanId.toString()
  } catch {
    // best-effort
  }
  return undefined
}

function _installTerminationCheckpointHook (executionContext, checkpointState) {
  const terminationManager = executionContext?.terminationManager
  if (!terminationManager || typeof terminationManager.terminate !== 'function') return
  if (terminationManager[kTerminationHookInstalled]) return

  const originalTerminate = terminationManager.terminate
  terminationManager.terminate = function (...terminateArgs) {
    const options = terminateArgs[0]
    if (_shouldSaveOnTermination(options)) {
      // Fire-and-forget: we just need to enqueue checkpoint updates before the
      // checkpoint manager is marked as terminating.
      void _maybeSaveCheckpoint(checkpointState, { Status: 'PENDING' })
    }

    return originalTerminate.apply(this, terminateArgs)
  }

  terminationManager[kTerminationHookInstalled] = true
}

function _shouldSaveOnTermination (options) {
  const reason = options?.reason
  return !NON_PENDING_TERMINATION_REASONS.has(reason)
}

function _maybeSaveCheckpoint (state, result) {
  if (!state || state.saved || state.savePromise) return state.savePromise
  if (!state.tracer || !state.span || !state.durableContext) return null

  state.savePromise = maybeSaveTraceContextCheckpoint(
    state.tracer,
    state.span,
    state.durableContext,
    state.checkpointAnchorSpanId,
    state.invocationEvent,
    result,
  ).catch(() => {
    // Best-effort — never break customer workloads.
  }).finally(() => {
    state.saved = true
    state.savePromise = null
  })

  return state.savePromise
}

module.exports = AwsDurableExecutionSdkJsHandlerPlugin
