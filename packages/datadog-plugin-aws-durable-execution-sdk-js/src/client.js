'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { getOperationId, isReplayedOp, observeDurablePromise, unwrapDurableError } = require('./util')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'

  // invoke has two overloads: invoke(name, funcId, ...) and invoke(funcId, ...).
  // They're distinguished by whether args[1] is a string (named form) or not.
  bindStart (ctx) {
    const args = ctx.arguments || []
    const isNamed = typeof args[1] === 'string'
    const operationName = isNamed ? args[0] : undefined
    const functionName = isNamed ? args[1] : args[0]

    const meta = {
      'aws.durable.replayed': String(isReplayedOp(ctx.self)),
    }
    if (functionName) {
      meta['aws.durable.invoke.function_name'] = functionName
    }
    if (operationName) {
      meta['aws.durable.operation_name'] = operationName
    }
    const operationId = getOperationId(ctx.self)
    if (operationId) {
      meta['aws.durable.operation_id'] = operationId
    }

    this.startSpan('aws.durable.invoke', {
      resource: operationName,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  // invoke is wrapped with kind:'Sync'. The returned DurablePromise is observed
  // lazily so the span finishes when user code awaits the result.
  end (ctx) {
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

module.exports = AwsDurableExecutionSdkJsClientPlugin
