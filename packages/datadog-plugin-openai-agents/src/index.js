'use strict'

const { channel } = require('dc-polyfill')

const { loadedAgentsCoreMods } = require('../../datadog-instrumentations/src/openai-agents')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { OpenAIAgentsIntegration } = require('./integration')
const { DDOpenAIAgentsProcessor } = require('./processor')

const agentsCoreLoadedCh = channel('apm:openai-agents:agents-core:loaded')
const responseClientCh = channel('apm:openai-agents:response:client')

/**
 * Drives the openai-agents integration through agents-core's
 * `TracingProcessor` interface. The instrumentation hook publishes the
 * loaded `@openai/agents-core` module on a channel; this plugin subscribes
 * during its constructor (which runs synchronously between `loadChannel`'s
 * publish and the addHook callback) and registers the processor.
 *
 * The instrumentation also publishes the OpenAI-compatible client's
 * baseURL on each `getResponse` / `getStreamedResponse` call so the
 * integration can resolve `model_provider`.
 *
 * The integration's `enabled` flag follows this plugin's configure()
 * lifecycle. Once registered, the processor stays inside agents-core for
 * the life of the process — flipping `enabled` is what re-engages tracing.
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

    const registerProcessor = (mod) => {
      if (typeof mod?.addTraceProcessor !== 'function') return
      mod.addTraceProcessor(new DDOpenAIAgentsProcessor(() => this.#integration))
    }
    // Drain any agents-core mods that loaded before this plugin was
    // constructed (e.g. another plugin's tests triggered the require first),
    // then keep listening for future loads. Set is bounded to one entry per
    // process — agents-core is a singleton dep.
    for (const mod of loadedAgentsCoreMods) registerProcessor(mod)
    agentsCoreLoadedCh.subscribe(({ mod }) => registerProcessor(mod))

    responseClientCh.subscribe(({ baseURL }) => {
      if (!this.#integration.enabled) return
      this.#integration.setClientBaseURL(baseURL)
    })
  }

  configure (config) {
    super.configure(config)
    this.#integration.setEnabled(!!config?.enabled)
  }
}

module.exports = OpenaiAgentsPlugin
