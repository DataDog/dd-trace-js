'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { isReplayedOp } = require('./util')

// Span names whose direct children must keep the default resource.
// These can have very high cardinality which is undesireable in the resource.
const HIGH_CARDINALITY_PARENT_SPAN_NAMES = new Set([
  'aws.durable.map',
  'aws.durable.parallel',
])

// The SDK calls intermediate operations for which we don't want to create
// spans to keep consistency with other tracers' implementations.
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

  // Extracts the operation name from arguments.
  // All context methods have 2 overrides: method(string, other) and method(other)
  // where args[0] is the name.
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
      // Pass the active store through unchanged so any nested spans
      // remain parented to the surrounding map/parallel span
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

// Extracts subType from runInChildContext arguments. The SDK has two
// overrides: `(name, fn, options)` and `(fn, options)`.
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
