'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const VertexAILLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/vertexai')
const GoogleVertexAITracingPlugin = require('./tracing')

class GoogleCloudVertexAIPlugin extends CompositePlugin {
  static id = 'google-cloud-vertexai'
  static get plugins () {
    return {
      llmobs: VertexAILLMObsPlugin,
      tracing: GoogleVertexAITracingPlugin,
    }
  }
}

module.exports = GoogleCloudVertexAIPlugin
