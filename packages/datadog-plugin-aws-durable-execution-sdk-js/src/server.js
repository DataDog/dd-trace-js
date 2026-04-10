'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class AwsDurableExecutionSdkJsServerPlugin extends ServerPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:withDurableExecution'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('workflow.execute', {
      service: this.serviceName({ pluginService: this.config.service }),
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

  // tracingChannel fires both asyncEnd and end; only finish the span when result or error is present
  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = AwsDurableExecutionSdkJsServerPlugin
