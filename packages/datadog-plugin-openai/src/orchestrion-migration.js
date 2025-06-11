'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiCompletionEndpointHook = require('./endpoint-hooks/completions')

const services = require('./services')
const makeUtilities = require('../../dd-trace/src/plugins/util/llm')

class OpenAiTracingPluginOrchestrion extends CompositePlugin {
  static get id () { return 'openai-orchestrion' } // TODO: rename this to "openai"
  static get system () { return 'openai' }
  static get plugins () {
    return {
      completion: OpenAiCompletionEndpointHook
    }
  }

  constructor (tracer, tracerConfig) {
    const metricsAndLogServices = services.init(tracerConfig) // TODO can we deprecate this?
    const utilities = makeUtilities('openai', tracerConfig) // TODO we'll need to deprecate this too

    super(metricsAndLogServices, utilities, tracer, tracerConfig)
  }
}

module.exports = OpenAiTracingPluginOrchestrion
