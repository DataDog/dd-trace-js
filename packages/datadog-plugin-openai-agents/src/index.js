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
 * lifecycle. Once registered, the processor stays inside agents-core for
 * the life of the process — flipping `enabled` is what re-engages tracing.
 */
class OpenaiAgentsPlugin extends Plugin {
  static id = 'openai-agents'

  #integration
  #registeredMods = new WeakSet()

  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.#integration = new OpenAIAgentsIntegration({
      tracer: this.tracer,
      config: tracerConfig,
    })

    this.addSub('apm:openai-agents:agents-core:loaded', ({ mod }) => {
      if (typeof mod?.addTraceProcessor !== 'function') return
      if (this.#registeredMods.has(mod)) return
      this.#registeredMods.add(mod)
      mod.addTraceProcessor(new DDOpenAIAgentsProcessor(() => this.#integration))
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
