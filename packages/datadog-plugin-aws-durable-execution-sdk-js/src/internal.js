'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseAwsDurableExecutionSdkJsInternalPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_step'
  static spanName = 'aws.durable_functions.step'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_functions',
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

class DurableContextImplRunInChildContextPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_runInChildContext'
  static spanName = 'aws.durable_functions.child_context'
}

class DurableContextImplWaitPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_wait'
  static spanName = 'aws.durable_functions.wait'
}

class DurableContextImplWaitForConditionPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCondition'
  static spanName = 'aws.durable_functions.wait_for_condition'
}

class DurableContextImplWaitForCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCallback'
  static spanName = 'aws.durable_functions.wait_for_callback'
}

class DurableContextImplCreateCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_createCallback'
  static spanName = 'aws.durable_functions.create_callback'
}

class DurableContextImplMapPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_map'
  static spanName = 'aws.durable_functions.map'
}

class DurableContextImplParallelPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_parallel'
  static spanName = 'aws.durable_functions.parallel'
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
