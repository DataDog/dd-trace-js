'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'
  static peerServicePrecursors = ['functionname']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('lambda.invoke', {
      service: this.serviceName({ pluginService: this.config.service }),
      resource: meta.functionname || 'lambda.invoke',
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts tags from the invoke method arguments.
   * ctx.arguments: [name, functionIdentifier, input, options?]
   * @param {{ arguments?: ArrayLike<unknown> }} ctx
   * @returns {Record<string, string>}
   */
  getTags (ctx) {
    const args = ctx.arguments || []
    const functionname = args[1] ? String(args[1]) : undefined

    const tags = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'client',
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

  // tracingChannel fires both asyncEnd and end; only finish the span when result or error is present
  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
