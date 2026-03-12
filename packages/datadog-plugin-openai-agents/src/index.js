'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiAgentsRunPlugin = require('./run')
const OpenAiAgentsToolPlugin = require('./tool')
const OpenAiAgentsHandoffPlugin = require('./handoff')

class OpenAiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static get plugins () {
    return {
      run: OpenAiAgentsRunPlugin,
      tool: OpenAiAgentsToolPlugin,
      handoff: OpenAiAgentsHandoffPlugin
    }
  }
}

module.exports = OpenAiAgentsPlugin
