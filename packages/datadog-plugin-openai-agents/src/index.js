'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage: llmobsStorage } = require('../../dd-trace/src/llmobs/storage')
const log = require('../../dd-trace/src/log')
const { MODEL_BASE_URL_STORE_KEY, MODEL_CALL_STORE_KEY, OpenAIAgentsIntegration } = require('./integration')
const { DDOpenAIAgentsProcessor } = require('./processor')

const legacyStorage = storage('legacy')

/**
 * Drives the openai-agents integration through agents-core's
 * `TracingProcessor` interface. The instrumentation hook publishes the
 * loaded `@openai/agents` module on a channel; this plugin subscribes
 * during its constructor (which runs synchronously between `loadChannel`'s
 * publish and the addHook callback) and registers the processor.
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
    this.#bindLLMObsStorage('apm:openai-agents:model:start', ({ agentsCoreSpanId } = {}) => {
      const store = llmobsStorage.getStore()
      if (!this.#integration.enabled || !this.#isLLMObsEnabled() || !agentsCoreSpanId) return store

      const agentDdSpan = this.#integration.getDDSpan(agentsCoreSpanId)
      const holder = this.#integration.getOrCreateModelCallHolder(agentsCoreSpanId, agentDdSpan)
      return {
        ...store,
        span: agentDdSpan,
        [MODEL_CALL_STORE_KEY]: holder,
      }
    })
    this.#bindLLMObsStorage('apm:openai-agents:tool:start', ({ agentsCoreSpan } = {}) => {
      const store = llmobsStorage.getStore()
      if (!this.#integration.enabled || !this.#isLLMObsEnabled() || !agentsCoreSpan) return store
      const ddSpan = this.#integration.getOrStartToolSpan(agentsCoreSpan)
      return ddSpan ? { ...store, span: ddSpan } : store
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

    // Activate the current agent's dd-trace span in legacyStorage for the
    // duration of model response calls and stream iterator advancement. This
    // makes the openai plugin's shimmer see the correct parent when it creates its
    // openai.request span, so all spans land in the same trace.
    this.addBind('apm:openai-agents:model:start', ({ agentsCoreSpanId, baseURL }) => {
      const store = legacyStorage.getStore()
      if (!this.#integration.enabled || !agentsCoreSpanId) return store
      const ddSpan = this.#integration.getDDSpan(agentsCoreSpanId)
      if (!ddSpan) return store
      const holder = this.#integration.getOrCreateModelCallHolder(agentsCoreSpanId, ddSpan)
      return { ...store, [MODEL_BASE_URL_STORE_KEY]: baseURL, [MODEL_CALL_STORE_KEY]: holder, span: ddSpan }
    })
    this.addBind('apm:openai-agents:tool:start', ({ agentsCoreSpan }) => {
      const store = legacyStorage.getStore()
      if (!this.#integration.enabled || !agentsCoreSpan) return store
      const ddSpan = this.#integration.getOrStartToolSpan(agentsCoreSpan)
      return ddSpan ? { ...store, span: ddSpan } : store
    })
    this.addSub('apm:openai-agents:agent:prepare', ({ agent, agentsCoreSpan }) => {
      this.#integration.tagAgentManifest(agentsCoreSpan, agent)
    })
    this.addSub('dd-trace:span:start', ({ span } = {}) => {
      if (!this.#integration.enabled || !this.#isLLMObsEnabled()) return
      const holder = legacyStorage.getStore()?.[MODEL_CALL_STORE_KEY] ||
        this.#integration.getModelCallHolderForProviderSpan(span)
      if (holder) this.#integration.trackProviderSpan(holder, span)
    })
  }

  #bindLLMObsStorage (event, transform) {
    try {
      dc.channel(event).bindStore(llmobsStorage, transform)
    } catch (error) {
      log.debug('[openai-agents] Failed to bind LLMObs storage: %s', error)
    }
  }

  #isLLMObsEnabled () {
    return !!this._tracerConfig.llmobs?.DD_LLMOBS_ENABLED
  }

  configure (config) {
    super.configure(config)
    this.#integration.configure(config)
  }
}

module.exports = OpenaiAgentsPlugin
