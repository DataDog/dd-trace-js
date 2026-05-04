'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { isReplayedOp } = require('./util')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'

  // invoke has two overloads:
  //   invoke(name, funcId, input?, config?)  — args[1] is a string (funcId)
  //   invoke(funcId, input?, config?)        — args[1] is an object or undefined
  bindStart (ctx) {
    const args = ctx.arguments || []
    const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
    const operationName = hasName ? args[0] : undefined
    const functionName = hasName ? args[1] : (typeof args[0] === 'string' ? args[0] : undefined)

    const meta = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'client',
      'aws.durable.replayed': String(isReplayedOp(ctx.self)),
    }
    if (functionName) {
      meta['aws.durable.invoke.function_name'] = functionName
    }

    this.startSpan('aws.durable.invoke', { resource: operationName, meta }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  error (ctxOrError) {
    super.error(ctxOrError)
    super.finish(ctxOrError)
  }
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
