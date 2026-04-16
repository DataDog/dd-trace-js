'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseAwsDurableExecutionSdkJsInternalPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_step'
  static spanName = 'workflow.step.execute'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
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
  static spanName = 'workflow.child_context.execute'
}

class DurableContextImplWaitPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_wait'
  static spanName = 'workflow.wait'
}

class DurableContextImplWaitForConditionPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCondition'
  static spanName = 'workflow.wait_for_condition'
}

class DurableContextImplWaitForCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCallback'
  static spanName = 'workflow.wait_for_callback'
}

class DurableContextImplCreateCallbackPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_createCallback'
  static spanName = 'workflow.create_callback'
}

class DurableContextImplMapPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_map'
  static spanName = 'workflow.map'
}

class DurableContextImplParallelPlugin extends BaseAwsDurableExecutionSdkJsInternalPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_parallel'
  static spanName = 'workflow.parallel'
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
