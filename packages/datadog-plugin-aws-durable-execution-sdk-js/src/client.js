'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'
  static peerServicePrecursors = ['functionname']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('aws.durable_execution.invoke', {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_execution',
      resource: meta.operationname || meta.functionname || 'aws.durable_execution.invoke',
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts tags from the invoke method arguments.
   * invoke has two overloads:
   *   invoke(name, funcId, input?, config?)  — args[1] is a string (funcId)
   *   invoke(funcId, input?, config?)        — args[1] is an object or undefined
   * @param {{ arguments?: ArrayLike<unknown> }} ctx
   * @returns {Record<string, string>}
   */
  getTags (ctx) {
    const args = ctx.arguments || []
    const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
    const operationname = hasName ? args[0] : undefined
    const functionname = hasName ? args[1] : (typeof args[0] === 'string' ? args[0] : undefined)

    const tags = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'client',
    }

    if (operationname) {
      tags.operationname = operationname
    }
    if (functionname) {
      tags.functionname = functionname
    }

    return tags
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }
  // tracingChannel fires both asyncEnd and end; Need to call finish in both cases to ensure the span is finished regardless of how the tracingChannel is configured.
  finish (ctx) {
    super.finish(ctx)
  }
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
