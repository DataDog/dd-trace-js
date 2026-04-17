'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class AwsDurableExecutionSdkJsServerPlugin extends ServerPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('aws.durable_functions.execute', {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_functions',
      resource: 'aws.durable_functions.execute',
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'server',
    }
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

module.exports = AwsDurableExecutionSdkJsServerPlugin
