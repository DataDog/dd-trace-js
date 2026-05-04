'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseAwsDurableExecutionSdkJsContextPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static kind = 'internal'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_step'
  static spanName = 'aws.durable_execution.step'

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const operationName = this.getOperationName(ctx)

    this.startSpan(this.constructor.spanName, {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_execution',
      resource: operationName || this.constructor.spanName,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts the operation name from arguments.
   * Most SDK methods use the pattern: (name?: string, ...rest) where
   * args[0] is the user-provided name if it's a string.
   * @param {{ arguments?: ArrayLike<unknown> }} ctx
   * @returns {string|undefined}
   */
  getOperationName (ctx) {
    const args = ctx.arguments || []
    return typeof args[0] === 'string' ? args[0] : undefined
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

class DurableContextImplRunInChildContextPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_runInChildContext'
  static spanName = 'aws.durable_execution.child_context'
}

class DurableContextImplWaitPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_wait'
  static spanName = 'aws.durable_execution.wait'
}

class DurableContextImplWaitForConditionPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCondition'
  static spanName = 'aws.durable_execution.wait_for_condition'
}

class DurableContextImplWaitForCallbackPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_waitForCallback'
  static spanName = 'aws.durable_execution.wait_for_callback'
}

class DurableContextImplCreateCallbackPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_createCallback'
  static spanName = 'aws.durable_execution.create_callback'
}

class DurableContextImplMapPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_map'
  static spanName = 'aws.durable_execution.map'
}

class DurableContextImplParallelPlugin extends BaseAwsDurableExecutionSdkJsContextPlugin {
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_parallel'
  static spanName = 'aws.durable_execution.parallel'
}

module.exports = {
  BaseAwsDurableExecutionSdkJsContextPlugin,
  DurableContextImplRunInChildContextPlugin,
  DurableContextImplWaitPlugin,
  DurableContextImplWaitForConditionPlugin,
  DurableContextImplWaitForCallbackPlugin,
  DurableContextImplCreateCallbackPlugin,
  DurableContextImplMapPlugin,
  DurableContextImplParallelPlugin,
}
