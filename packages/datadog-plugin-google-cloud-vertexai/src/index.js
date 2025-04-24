'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const GoogleVertexAITracingPlugin = require('./tracing')
const VertexAILLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/vertexai')

class GoogleCloudVertexAIPlugin extends CompositePlugin {
  static get id () { return 'google-cloud-vertexai' }
  static get plugins () {
    return {
      llmobs: VertexAILLMObsPlugin,
      tracing: GoogleVertexAITracingPlugin
    }
  }
}

module.exports = GoogleCloudVertexAIPlugin
