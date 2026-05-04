'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { OpenAIAgentsIntegration } = require('./integration')

let currentIntegration

/**
 * The openai-agents integration is driven entirely by agents-core's own
 * TracingProcessor interface. This plugin owns the integration lifecycle and
 * publishes it via a module-level singleton; the addHook in
 * `datadog-instrumentations/src/openai-agents.js` reads the singleton and
 * calls `mod.addTraceProcessor(...)` when the module loads.
 *
 * The integration's `enabled` flag follows this plugin's configure() lifecycle.
 * The processor stays registered inside agents-core for the life of the
 * process — re-enabling the plugin later flips the flag back on.
 */
class OpenaiAgentsPlugin extends Plugin {
  static id = 'openai-agents'

  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    const tagger = new LLMObsTagger(tracerConfig, true)
    this._integration = new OpenAIAgentsIntegration({
      tracer: this.tracer,
      tagger,
      config: tracerConfig,
    })
    currentIntegration = this._integration
  }

  configure (config) {
    super.configure(config)
    this._integration.setEnabled(!!config?.enabled)
  }
}

module.exports = OpenaiAgentsPlugin
module.exports.getIntegration = () => currentIntegration
