'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const {
  preserveOtelContext,
  suppressOtelInstrumentation,
} = require('../../dd-trace/src/opentelemetry/suppression')

const legacyStorage = storage('legacy')
const GENKIT_TRACER_NAME = 'genkit-tracer'

const operations = {
  embedder: { kind: 'client', spanName: 'genkit.request', type: 'embedding' },
  flow: { kind: 'internal', spanName: 'genkit.workflow', type: 'flow' },
  model: { kind: 'client', spanName: 'genkit.request', type: 'generation' },
  retriever: { kind: 'client', spanName: 'genkit.request', type: 'retrieval' },
  tool: { kind: 'internal', spanName: 'genkit.tool', type: 'tool' },
}

class GenkitTracingPlugin extends TracingPlugin {
  static id = 'genkit'
  static operation = 'run'
  static system = 'genkit'
  static prefix = 'tracing:orchestrion:@genkit-ai/core:runInNewSpan'

  /**
   * Start a span for an allowed Genkit operation while preserving context for ignored native spans.
   *
   * @param {object} ctx Orchestrion call context.
   * @returns {object|undefined} The async context store for the wrapped operation.
   */
  bindStart (ctx) {
    const options = ctx.arguments?.length === 3 ? ctx.arguments[1] : ctx.arguments?.[0]
    const labels = options?.labels
    const subtype = labels?.['genkit:metadata:subtype']
    const operation = labels?.['genkit:type'] === 'flowStep'
      ? { kind: 'internal', spanName: 'genkit.workflow', type: 'flowStep' }
      : operations[subtype]

    if (!operation) {
      const currentStore = legacyStorage.getStore()
      if (this._tracerConfig.DD_TRACE_OTEL_ENABLED) {
        return this.#suppressNativeGenkitSpan(currentStore)
      }
      return currentStore
    }

    const actionName = options?.metadata?.name

    ctx.genkit = { actionName, operation: operation.type, options }

    this.startSpan(operation.spanName, {
      service: this.config.service,
      resource: actionName || operation.spanName,
      type: 'genkit',
      kind: operation.kind,
      meta: {
        'genkit.operation.type': operation.type,
        'genkit.action.name': actionName,
      },
    }, ctx)

    if (this._tracerConfig.DD_TRACE_OTEL_ENABLED) {
      ctx.currentStore = this.#suppressNativeGenkitSpan(ctx.currentStore)
    }

    return ctx.currentStore
  }

  /**
   * Prevent the Genkit OTel bridge span from duplicating this integration's authoritative span.
   *
   * @param {object|undefined} authoritativeStore Datadog context to retain for the operation.
   * @returns {object} Store configured to suppress only Genkit's native OTel instrumentation scope.
   */
  #suppressNativeGenkitSpan (authoritativeStore) {
    return {
      ...authoritativeStore,
      [preserveOtelContext]: true,
      [suppressOtelInstrumentation]: GENKIT_TRACER_NAME,
    }
  }

  /**
   * Finish a selected Genkit operation after its promise settles.
   *
   * @param {object} ctx Orchestrion call context.
   * @returns {void}
   */
  asyncEnd (ctx) {
    if (!ctx.genkit) return

    super.finish(ctx)
  }
}

module.exports = GenkitTracingPlugin
