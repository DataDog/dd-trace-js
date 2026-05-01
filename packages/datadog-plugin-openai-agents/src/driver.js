'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { OpenAIAgentsIntegration } = require('./integration')
const { setIntegration } = require('./registry')

/**
 * Plugin that owns the OpenAIAgentsIntegration lifecycle. Has no orchestrion
 * channel subscription — its only role is to instantiate the integration with
 * tracer+tagger refs and publish it to the registry so the `@openai/agents-core`
 * module load hook can register the TracingProcessor.
 *
 * The integration's `enabled` flag follows this plugin's configure() lifecycle.
 * The module-level singleton in registry.js is set once at construction and
 * stays set for the life of the process — re-enabling the plugin later just
 * flips the integration's flag back on, the processor is already registered
 * inside agents-core.
 */
class OpenaiAgentsDriverPlugin extends Plugin {
  static id = 'openai-agents-driver'

  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    const tagger = new LLMObsTagger(tracerConfig, true)
    this._integration = new OpenAIAgentsIntegration({
      tracer: this.tracer,
      tagger,
      config: tracerConfig,
    })
    setIntegration(this._integration)
  }

  configure (config) {
    super.configure(config)
    this._integration.setEnabled(!!config?.enabled)
  }
}

module.exports = OpenaiAgentsDriverPlugin
