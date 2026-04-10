'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseAwsDurableExecutionSdkJsInternalPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'server'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_step'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('workflow.step.execute', {
      service: this.serviceName({ pluginService: this.config.service }),
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'internal',
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class DurableContextImplRunInChildContextPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_runInChildContext'
}

class DurableContextImplWaitPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_wait'
}

class DurableContextImplWaitForConditionPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCondition'
}

class DurableContextImplWaitForCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCallback'
}

class DurableContextImplCreateCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_createCallback'
}

class DurableContextImplMapPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_map'
}

class DurableContextImplParallelPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_parallel'
}

module.exports = {
  BaseAwsDurableExecutionSdkJsInternalPlugin,
  DurableContextImplRunInChildContextPlugin,
  DurableContextImplWaitPlugin,
  DurableContextImplWaitForConditionPlugin,
  DurableContextImplWaitForCallbackPlugin,
  DurableContextImplCreateCallbackPlugin,
  DurableContextImplMapPlugin,
  DurableContextImplParallelPlugin,
}
