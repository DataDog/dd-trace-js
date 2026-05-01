'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenaiAgentsDriverPlugin = require('./driver')
const turnPlugins = require('./turn')

/**
 * The openai-agents integration is driven entirely by agents-core's own
 * TracingProcessor interface. The driver plugin owns the integration lifecycle
 * and publishes it via the registry; the addHook in
 * `datadog-instrumentations/src/openai-agents.js` reads the registry and calls
 * `mod.addTraceProcessor(...)` when the module loads.
 *
 * The turn plugins are a Python-parity supplement: they subscribe to
 * `AgentRunner._runSingleTurn(Streamed)` channels and tag the current agent
 * span with the agent manifest (framework, name, instructions, tools, etc.).
 */
const plugins = {
  [OpenaiAgentsDriverPlugin.id]: OpenaiAgentsDriverPlugin,
}
for (const Plugin of turnPlugins) {
  plugins[Plugin.id] = Plugin
}

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = plugins
}

module.exports = OpenaiAgentsPlugin
