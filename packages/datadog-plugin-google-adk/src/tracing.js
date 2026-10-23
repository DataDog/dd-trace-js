'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { spanHasError } = require('../../dd-trace/src/llmobs/util')
const { extractModelInfo } = require('../../dd-trace/src/llmobs/plugins/google-adk/util')

function createRunnerPlugin (method, id, prefix) {
  return class RunnerTracingPlugin extends TracingPlugin {
    static id = id
    static prefix = prefix

    bindStart (ctx) {
      const { modelName, modelProvider } = extractModelInfo(ctx.self?.agent?.model)
      this.startSpan('google_adk.request', {
        service: this.config.service,
        kind: 'internal',
        component: 'google-adk',
        meta: {
          'resource.name': `Runner.${method}`,
          'google_adk.request.model': modelName,
          'google_adk.request.provider': modelProvider,
        },
      }, ctx)
      return ctx.currentStore
    }
  }
}

function createRunnerNextPlugin (id, prefix) {
  return class RunnerNextTracingPlugin extends TracingPlugin {
    static id = id
    static prefix = prefix

    bindStart (ctx) {
      return ctx.currentStore
    }

    asyncEnd (ctx) {
      const span = ctx.currentStore?.span
      if (span && (ctx.result?.done === true || spanHasError(span))) span.finish()
    }
  }
}

class ToolTracingPlugin extends TracingPlugin {
  static id = 'google_adk_tool'
  static prefix = 'tracing:orchestrion:@google/adk:callToolAsync'

  bindStart (ctx) {
    const tool = ctx.arguments?.[0]
    const { modelName, modelProvider } = extractModelInfo(ctx.arguments?.[2]?.invocationContext?.agent?.model)
    this.startSpan('google_adk.request', {
      service: this.config.service,
      kind: 'internal',
      component: 'google-adk',
      meta: {
        'resource.name': `${tool?.constructor?.name ?? 'Tool'}.runAsync`,
        'google_adk.request.model': modelName,
        'google_adk.request.provider': modelProvider,
      },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

class CodeExecuteTracingPlugin extends TracingPlugin {
  static id = 'google_adk_code_execute'
  static prefix = 'tracing:orchestrion:@google/adk:executeCode'

  bindStart (ctx) {
    const { modelName, modelProvider } = extractModelInfo(ctx.arguments?.[0]?.invocationContext?.agent?.model)
    this.startSpan('google_adk.request', {
      service: this.config.service,
      kind: 'internal',
      component: 'google-adk',
      meta: {
        'resource.name': `${ctx.self?.constructor?.name}.executeCode`,
        'google_adk.request.model': modelName,
        'google_adk.request.provider': modelProvider,
      },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

module.exports = [
  createRunnerPlugin(
    'runAsync',
    'google_adk_runner_run_async',
    'tracing:orchestrion:@google/adk:Runner_runAsync'
  ),
  createRunnerNextPlugin(
    'google_adk_runner_run_async_next',
    'tracing:orchestrion:@google/adk:Runner_runAsync:next'
  ),
  createRunnerPlugin(
    'runLive',
    'google_adk_runner_run_live',
    'tracing:orchestrion:@google/adk:Runner_runLive'
  ),
  createRunnerNextPlugin(
    'google_adk_runner_run_live_next',
    'tracing:orchestrion:@google/adk:Runner_runLive:next'
  ),
  ToolTracingPlugin,
  CodeExecuteTracingPlugin,
]
