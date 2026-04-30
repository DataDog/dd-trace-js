'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { maybeSaveTraceContextCheckpoint } = require('./trace-checkpoint')

// Non-pending termination reasons where we should NOT save a checkpoint, since the execution is not expected to resume.
const NON_PENDING_TERMINATION_REASONS = new Set([
  'CHECKPOINT_FAILED',
  'SERDES_FAILED',
  'CONTEXT_VALIDATION_ERROR',
])
const kTerminationHookInstalled = Symbol('dd-trace:aws-durable-execution-sdk-js:termination-hook-installed')

class AwsDurableExecutionSdkJsServerPlugin extends ServerPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  bindStart(ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('aws.durable_execution.execute', {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_execution',
      resource: 'aws.durable_execution.execute',
      meta,
    }, ctx)

    // Wrap the user handler so we can capture the DurableContext and save the
    // trace-context checkpoint AFTER the handler returns (or throws).
    // This ensures the checkpoint contains the fully-updated trace context
    //
    // The isTerminating guard in maybeSaveTraceContextCheckpoint prevents hangs
    // when the CheckpointManager has already started tearing down.
    //
    // runHandler signature: (event, context, executionContext, mode, checkpointToken, handler)
    const args = ctx.arguments
    if (args && args.length >= 6 && typeof args[5] === 'function') {
      const originalHandler = args[5]
      const invocationEvent = args[0]
      const span = ctx.currentStore?.span
      const tracer = this._tracer
      // Capture the grandparent span_id (parent of aws.lambda) so checkpoint
      // headers point at the root aws.durable-execution span across invocations.
      const grandparentSpanId = _getGrandparentSpanId(tracer, span)
      const checkpointState = {
        durableContext: undefined,
        grandparentSpanId,
        invocationEvent,
        savePromise: null,
        saved: false,
        span,
        tracer,
      }

      _installTerminationCheckpointHook(args[2], checkpointState)

      args[5] = async function (...handlerArgs) {
        checkpointState.durableContext = handlerArgs[1]
        let result
        try {
          result = await originalHandler.apply(this, handlerArgs)
        } finally {
          try {
            await _maybeSaveCheckpoint(checkpointState, result)
          } catch {
            // Best-effort — never break the customer's handler
          }
        }
        return result
      }
    }

    return ctx.currentStore
  }

  getTags(ctx) {
    return {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'server',
    }
  }

  asyncEnd(ctx) {
    this.finish(ctx)
  }

  end(ctx) {
    this.finish(ctx)
  }

  // tracingChannel fires both asyncEnd and end; Need to call finish in both cases to ensure the span is finished regardless of how the tracingChannel is configured.
  finish(ctx) {
    super.finish(ctx)
  }
}

/**
 * Return the parent_id of the currently active span — that is, the span_id of
 * the "grandparent" relative to the aws.durable_execution.execute span we just
 * started.  In datadog-lambda-js this resolves to the root aws.durable-execution
 * span created by the wrapper.
 * @param {object} tracer
 * @param {object} span
 * @returns {string | undefined}
 */
function _getGrandparentSpanId(tracer, span) {
  try {
    // span.context()._parentId holds the parent of aws.durable_execution.execute.
    // That parent is aws.lambda, whose own parent is the durable root span.
    // To find that root, walk via the active tracer's scope.
    const active = tracer.scope().active()
    if (active && typeof active.context === 'function') {
      const ctx = active.context()
      const parentId = ctx?._parentId
      if (parentId) return parentId.toString()
    }
  } catch {
    // best-effort
  }
  return undefined
}

function _installTerminationCheckpointHook(executionContext, checkpointState) {
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

function _shouldSaveOnTermination(options) {
  const reason = options?.reason
  return !NON_PENDING_TERMINATION_REASONS.has(reason)
}

function _maybeSaveCheckpoint(state, result) {
  if (!state || state.saved || state.savePromise) return state.savePromise
  if (!state.tracer || !state.span || !state.durableContext) return null

  state.savePromise = maybeSaveTraceContextCheckpoint(
    state.tracer,
    state.span,
    state.durableContext,
    state.grandparentSpanId,
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

module.exports = AwsDurableExecutionSdkJsServerPlugin
