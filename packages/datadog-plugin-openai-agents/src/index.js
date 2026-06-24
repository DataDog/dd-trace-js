'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { OpenAIAgentsIntegration } = require('./integration')
const { DDOpenAIAgentsProcessor } = require('./processor')

const legacyStorage = storage('legacy')

/**
 * Drives the openai-agents integration through agents-core's
 * `TracingProcessor` interface. The instrumentation hook publishes the
 * loaded `@openai/agents` module on a channel; this plugin subscribes
 * during its constructor (which runs synchronously between `loadChannel`'s
 * publish and the addHook callback) and registers the processor.
 *
 * The instrumentation also publishes the OpenAI-compatible client's
 * baseURL on each `getResponse` call, and the orchestrion traceAsyncIterator
 * rewriter publishes it on each `getStreamedResponse` call, so the
 * integration can resolve `model_provider`.
 *
 * The integration's `enabled` flag follows this plugin's configure()
 * lifecycle. Each loaded version of the agents package replaces all processors
 * via setTraceProcessors() on module load, so the plugin re-registers a
 * fresh DDOpenAIAgentsProcessor for each module version that fires the channel.
 */
class OpenaiAgentsPlugin extends Plugin {
  static id = 'openai-agents'

  #integration

  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.#integration = new OpenAIAgentsIntegration({
      tracer: this.tracer,
      config: tracerConfig,
    })

    // Register a new processor each time @openai/agents fires the channel.
    // Each module version calls setTraceProcessors() on load (which replaces
    // all processors), so we must re-register after every new version loads.
    // The instrumentation's patchedMods WeakSet ensures each module instance
    // fires the channel exactly once, so no duplicates accumulate.
    this.addSub('apm:openai-agents:agents-core:loaded', ({ mod }) => {
      const processor = new DDOpenAIAgentsProcessor(() => this.#integration)
      if (typeof mod?.addTraceProcessor === 'function') {
        mod.addTraceProcessor(processor)
      } else {
        mod.getGlobalTraceProvider().registerProcessor(processor)
      }
    })

    this.addSub('apm:openai-agents:response:client', ({ baseURL }) => {
      if (!this.#integration.enabled) return
      this.#integration.setClientBaseURL(baseURL)
    })

    // Capture baseURL from getStreamedResponse via the orchestrion traceAsyncIterator
    // rewriter (helpers/rewriter/instrumentations/openai-agents.js).
    this.addSub('tracing:orchestrion:@openai/agents-openai:OAI_getStreamedResponse:start', (ctx) => {
      const baseURL = ctx.self?.client?.baseURL
      if (baseURL && this.#integration.enabled) this.#integration.setClientBaseURL(baseURL)
    })

    // Activate the current agent's dd-trace span in legacyStorage for the
    // duration of getResponse (and all its async continuations). This makes the
    // openai plugin's shimmer see the correct parent when it creates its
    // openai.request span, so all spans land in the same trace.
    this.addBind('apm:openai-agents:model:start', ({ agentsCoreSpanId }) => {
      if (!this.#integration.enabled || !agentsCoreSpanId) return legacyStorage.getStore()
      const ddSpan = this.#integration.getDDSpan(agentsCoreSpanId)
      if (!ddSpan) return legacyStorage.getStore()
      return { ...legacyStorage.getStore(), span: ddSpan }
    })
  }

  configure (config) {
    super.configure(config)
    this.#integration.setEnabled(!!config?.enabled)
  }
}

module.exports = OpenaiAgentsPlugin
