'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { addOpMeta, unwrapDurableError } = require('./util')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'
  static settleChannel = 'apm:aws-durable-execution-sdk-js:invoke:settle'

  constructor (...args) {
    super(...args)
    this.addSub(this.constructor.settleChannel, ctx => this.settle(ctx))
  }

  // invoke has two overloads: invoke(name, funcId, ...) and invoke(funcId, ...).
  // They're distinguished by whether args[1] is a string (named form) or not.
  bindStart (ctx) {
    const args = ctx.arguments || []
    const isNamed = typeof args[1] === 'string'
    const operationName = isNamed ? args[0] : undefined
    const functionName = isNamed ? args[1] : args[0]

    const meta = {}
    if (functionName) {
      meta['aws.durable.invoke.function_name'] = functionName
    }
    if (operationName) {
      meta['aws.durable.operation_name'] = operationName
    }
    addOpMeta(meta, ctx.self)

    this.startSpan(this.operationName(), {
      resource: operationName,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  settle (ctx) {
    if (ctx.error !== undefined) {
      ctx.currentStore?.span?.setTag('error', unwrapDurableError(ctx))
    }
    this.finish(ctx)
  }

  error (ctxOrError) {
    this.settle(ctxOrError)
  }
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
