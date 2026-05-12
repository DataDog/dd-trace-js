'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getOperationId, isReplayedOp, observeDurablePromise, unwrapDurableError } = require('./util')

// Span names whose direct children must keep the default resource.
// These can have very high cardinality which is undesireable in the resource.
const HIGH_CARDINALITY_PARENT_SPAN_NAMES = new Set([
  'aws.durable.map',
  'aws.durable.parallel',
])

// The SDK emits these subTypes as internal scaffolding around map/parallel iterations; not user-visible operations.
const SUPPRESSED_CHILD_CONTEXT_SUBTYPES = new Set([
  'Map',
  'Parallel',
  'MapIteration',
  'ParallelBranch',
])

class BaseContextPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'

  bindStart (ctx) {
    const spanName = this.constructor.spanName
    const parentName = this.activeSpan?.context()._name
    const operationName = this.getOperationName(ctx)
    const resource = HIGH_CARDINALITY_PARENT_SPAN_NAMES.has(parentName) ? undefined : operationName

    const meta = { 'aws.durable.replayed': String(isReplayedOp(ctx.self)) }
    if (operationName) {
      meta['aws.durable.operation_name'] = operationName
    }
    const operationId = getOperationId(ctx.self)
    if (operationId) {
      meta['aws.durable.operation_id'] = operationId
    }

    this.startSpan(spanName, {
      resource,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  // All context methods have two overloads: method(name, …) and method(…); args[0] is the name in the first form.
  getOperationName (ctx) {
    const args = ctx.arguments || []
    return typeof args[0] === 'string' ? args[0] : undefined
  }

  // invoke is wrapped with kind:'Sync'. The returned DurablePromise is observed
  // lazily so the span finishes when user code awaits the result.
  end (ctx) {
    if (ctx._ddSuppressed) return
    observeDurablePromise(ctx.result, err => {
      if (ctx._ddFinished) return
      ctx._ddFinished = true
      if (err !== undefined) {
        const errCtx = unwrapDurableError({ ...ctx, error: err })
        ctx.currentStore?.span?.setTag('error', errCtx.error)
      }
      this.finish(ctx)
    })
  }

  error (ctxOrError) {
    if (ctxOrError?._ddFinished) return
    if (ctxOrError && typeof ctxOrError === 'object') ctxOrError._ddFinished = true
    super.error(unwrapDurableError(ctxOrError))
    super.finish(ctxOrError)
  }
}

function makeContextPlugin (method, spanName) {
  return class extends BaseContextPlugin {
    static prefix = `tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_${method}`
    static spanName = spanName
  }
}

class RunInChildContextPlugin extends BaseContextPlugin {
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

  error (ctxOrError) {
    if (ctxOrError?._ddSuppressed) return
    super.error(ctxOrError)
  }
}

// runInChildContext has two overloads: `(name, fn, options)` and `(fn, options)`.
function getRunInChildContextSubType (ctx) {
  const args = ctx.arguments || []
  const opts = typeof args[0] === 'string' ? args[2] : args[1]
  return opts?.subType
}

module.exports = {
  step: makeContextPlugin('step', 'aws.durable.step'),
  wait: makeContextPlugin('wait', 'aws.durable.wait'),
  waitForCondition: makeContextPlugin('waitForCondition', 'aws.durable.wait_for_condition'),
  waitForCallback: makeContextPlugin('waitForCallback', 'aws.durable.wait_for_callback'),
  createCallback: makeContextPlugin('createCallback', 'aws.durable.create_callback'),
  map: makeContextPlugin('map', 'aws.durable.map'),
  parallel: makeContextPlugin('parallel', 'aws.durable.parallel'),
  runInChildContext: RunInChildContextPlugin,
}
