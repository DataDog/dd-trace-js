'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugins = require('./internal')
const clientPlugin = require('./client')

const plugins = {}

// Register internal plugins by their id
for (const Plugin of internalPlugins) {
  plugins[Plugin.id] = Plugin
}

// Register client plugin by its id
plugins[clientPlugin.id] = clientPlugin

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = plugins
}

module.exports = OpenaiAgentsPlugin
