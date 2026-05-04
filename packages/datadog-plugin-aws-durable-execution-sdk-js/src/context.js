'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { isReplayedOp } = require('./util')

// Span names whose direct children must keep the default resource (the span
// name) — `map` and `parallel` can iterate over unbounded inputs, so allowing
// per-iteration user-provided resource names would explode cardinality.
const HIGH_CARDINALITY_PARENT_SPAN_NAMES = new Set([
  'aws.durable.map',
  'aws.durable.parallel',
])

// `OperationSubType` values the SDK passes to `runInChildContext` when it is
// running map/parallel bookkeeping internally. We don't trace those — they are
// duplicates of the surrounding map/parallel span (outer wrap) or per-iteration
// wrappers with high-cardinality names like `map-item-3` / `parallel-branch-7`.
const SUPPRESSED_CHILD_CONTEXT_SUBTYPES = new Set([
  'Map',
  'Parallel',
  'MapIteration',
  'ParallelBranch',
])

class BaseAwsDurableExecutionSdkJsContextPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_step'
  static spanName = 'aws.durable.step'

  bindStart (ctx) {
    const spanName = this.constructor.spanName
    const parentName = this.activeSpan?.context()._name
    const operationName = HIGH_CARDINALITY_PARENT_SPAN_NAMES.has(parentName)
      ? undefined
      : this.getOperationName(ctx)

    this.startSpan(spanName, {
      resource: operationName,
      kind: this.constructor.kind,
      meta: { 'aws.durable.replayed': String(isReplayedOp(ctx.self)) },
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts the operation name from arguments.
   * Most SDK methods use the pattern: (name?: string, ...rest) where
   * args[0] is the user-provided name if it's a string.
   * @param {{ arguments?: ArrayLike<unknown> }} ctx
   * @returns {string|undefined}
   */
  getOperationName (ctx) {
    const args = ctx.arguments || []
    return typeof args[0] === 'string' ? args[0] : undefined
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  error (ctxOrError) {
    super.error(ctxOrError)
    super.finish(ctxOrError)
  }
}

class DurableContextImplRunInChildContextPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_runInChildContext'
  static spanName = 'aws.durable.child_context'

  bindStart (ctx) {
    if (SUPPRESSED_CHILD_CONTEXT_SUBTYPES.has(getRunInChildContextSubType(ctx))) {
      // Pass the active store through unchanged so any nested spans (e.g. user
      // steps inside a map iteration) remain parented to the surrounding
      // map/parallel span instead of the suppressed child_context.
      ctx._ddSuppressed = true
      const store = storage('legacy').getStore()
      ctx.currentStore = store
      return store
    }
    return super.bindStart(ctx)
  }

  asyncEnd (ctx) {
    if (ctx._ddSuppressed) return
    super.asyncEnd(ctx)
  }

  error (ctxOrError) {
    if (ctxOrError?._ddSuppressed) return
    super.error(ctxOrError)
  }
}

/**
 * Extracts `subType` from `runInChildContext` arguments. The SDK supports two
 * shapes: `(name, fn, options)` and `(fn, options)`.
 *
 * @param {{ arguments?: ArrayLike<unknown> }} ctx
 * @returns {string | undefined}
 */
function getRunInChildContextSubType (ctx) {
  const args = ctx.arguments || []
  const opts = typeof args[0] === 'string' ? args[2] : args[1]
  return opts?.subType
}

class DurableContextImplWaitPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_wait'
  static spanName = 'aws.durable.wait'
}

class DurableContextImplWaitForConditionPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCondition'
  static spanName = 'aws.durable.wait_for_condition'
}

class DurableContextImplWaitForCallbackPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCallback'
  static spanName = 'aws.durable.wait_for_callback'
}

class DurableContextImplCreateCallbackPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_createCallback'
  static spanName = 'aws.durable.create_callback'
}

class DurableContextImplMapPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_map'
  static spanName = 'aws.durable.map'
}

class DurableContextImplParallelPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_parallel'
  static spanName = 'aws.durable.parallel'
}

module.exports = {
  BaseAwsDurableExecutionSdkJsContextPlugin,
  DurableContextImplRunInChildContextPlugin,
  DurableContextImplWaitPlugin,
  DurableContextImplWaitForConditionPlugin,
  DurableContextImplWaitForCallbackPlugin,
  DurableContextImplCreateCallbackPlugin,
  DurableContextImplMapPlugin,
  DurableContextImplParallelPlugin,
}
