'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const [
  OpenAIAgentsGetResponsePlugin,
  OpenAIAgentsGetStreamedResponsePlugin
] = require('./client')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'

  static plugins = {
    getResponse: OpenAIAgentsGetResponsePlugin,
    getStreamedResponse: OpenAIAgentsGetStreamedResponsePlugin
  }
}

module.exports = OpenaiAgentsPlugin
