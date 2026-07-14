'use strict'

const GenkitLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/genkit')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const GenkitTracingPlugin = require('./tracing')

class GenkitPlugin extends CompositePlugin {
  static id = 'genkit'

  /**
   * Compose LLMObs enrichment before the tracing plugin finishes the shared span.
   *
   * @returns {object} Genkit plugin members.
   */
  static get plugins () {
    return {
      llmobs: GenkitLLMObsPlugin,
      tracing: GenkitTracingPlugin,
    }
  }
}

module.exports = GenkitPlugin
