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
const kDurableRootSpan = Symbol('dd-trace:aws-durable-execution-sdk-js:durable-root-span')
const kDurableSpansFinished = Symbol('dd-trace:aws-durable-execution-sdk-js:durable-spans-finished')

class AwsDurableExecutionSdkJsServerPlugin extends ServerPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  bindStart(ctx) {
    const meta = this.getTags(ctx)
    const args = ctx.arguments
    const invocationEvent = args?.[0]
    const rootExecutionSpan = _createDurableRootExecutionSpan(this, invocationEvent, meta)

    const executeSpanOptions = {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_execution',
      resource: 'aws.durable_execution.execute',
      meta,
    }
    if (rootExecutionSpan) {
      executeSpanOptions.childOf = rootExecutionSpan
    }

    this.startSpan('aws.durable_execution.execute', executeSpanOptions, ctx)
    if (rootExecutionSpan && ctx.currentStore) {
      ctx.currentStore[kDurableRootSpan] = rootExecutionSpan
    }

    // Wrap the user handler so we can capture the DurableContext.
    // _datadog checkpoints are saved only from the termination hook path,
    // i.e. only when we expect follow-up invocations.
    // runHandler signature: (event, context, executionContext, mode, checkpointToken, handler)
    if (args && args.length >= 6 && typeof args[5] === 'function') {
      const originalHandler = args[5]
      const span = ctx.currentStore?.span
      const tracer = this._tracer
      // Capture the regular parent span_id of aws.durable_execution.execute
      // for first-checkpoint parent linkage.
      const parentSpanId = _getParentSpanId(span)
      const checkpointState = {
        durableContext: undefined,
        parentSpanId,
        invocationEvent,
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

  // tracingChannel fires both asyncEnd and end; Need to call finish in both cases
  // to ensure the span is finished regardless of how the tracingChannel is configured.
  finish(ctx) {
    if (ctx?.currentStore?.[kDurableSpansFinished]) return

    super.finish(ctx)

    const rootSpan = ctx?.currentStore?.[kDurableRootSpan]
    if (rootSpan && typeof rootSpan.finish === 'function') {
      rootSpan.finish()
    }

    if (ctx?.currentStore) {
      ctx.currentStore[kDurableSpansFinished] = true
    }
  }
}

/**
 * Return the parent_id of aws.durable_execution.execute.
 * @param {object} span
 * @returns {string | undefined}
 */
function _getParentSpanId(span) {
  try {
    const parentId = span?.context?.()?._parentId
    if (parentId) return parentId.toString()
  } catch {
    // best-effort
  }
  return undefined
}

function _extractExecutionStartTime(event) {
  const operations = event?.InitialExecutionState?.Operations
  if (!Array.isArray(operations) || operations.length === 0) return undefined

  const firstStartTs = operations[0]?.StartTimestamp
  if (firstStartTs === undefined || firstStartTs === null) return undefined

  const parsed = Number(firstStartTs)
  if (Number.isNaN(parsed)) return undefined

  return parsed
}

function _createDurableRootExecutionSpan(plugin, event, meta) {
  if (!event || typeof event !== 'object') {
    return null
  }

  const executionArn = event?.DurableExecutionArn
  if (!executionArn) {
    return null
  }

  const operations = event?.InitialExecutionState?.Operations
  if (!Array.isArray(operations) || operations.length !== 1) {
    return null
  }

  const startTime = _extractExecutionStartTime(event)
  const serviceName = process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable-execution'
  const resourceName = executionArn.includes(':') ? executionArn.split(':').pop() : executionArn
  const spanOptions = {
    service: serviceName,
    resource: resourceName,
    type: 'serverless',
    kind: 'server',
    meta: {
      ...meta,
      'durable.execution_arn': executionArn,
      'durable.is_root_span': true,
      'durable.invocation_count': operations?.length ?? 0,
    },
  }
  if (startTime !== undefined) {
    spanOptions.startTime = startTime
  }

  return plugin.startSpan('aws.durable-execution', spanOptions, false)
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
    state.parentSpanId,
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
