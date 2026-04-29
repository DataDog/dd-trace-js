'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'
  static peerServicePrecursors = ['aws.durable.invoke.function_name']

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const functionName = meta['aws.durable.invoke.function_name']

    this.startSpan('aws.durable.invoke', {
      resource: functionName || 'aws.durable.invoke',
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts tags from the invoke method arguments.
   * invoke has two overloads:
   *   invoke(name, funcId, input?, config?)  — args[1] is a string (funcId)
   *   invoke(funcId, input?, config?)        — args[1] is an object or undefined
   * @param {{ arguments?: ArrayLike<unknown>, self?: object }} ctx
   * @returns {Record<string, string>}
   */
  getTags (ctx) {
    const args = ctx.arguments || []
    const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
    const functionName = hasName ? args[1] : (typeof args[0] === 'string' ? args[0] : undefined)

    const tags = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'client',
    }

    if (functionName) {
      tags['aws.durable.invoke.function_name'] = functionName
    }

    tags['aws.durable.replayed'] = String(isReplayedOp(ctx.self))

    return tags
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  error (ctxOrError) {
    super.error(ctxOrError)
    super.finish(ctxOrError)
  }
}

/**
 * Returns true if the op the DurableContextImpl is about to run will be served
 * from the SDK's checkpoint (i.e. the next stepId already has a SUCCEEDED entry).
 * @param {object} [ctxImpl]
 * @returns {boolean}
 */
function isReplayedOp (ctxImpl) {
  try {
    const stepId = ctxImpl?.getNextStepId?.()
    if (!stepId) return false
    const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
    return stepData?.Status === 'SUCCEEDED'
  } catch {
    return false
  }
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
module.exports.isReplayedOp = isReplayedOp
