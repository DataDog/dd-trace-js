'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const llmobsPlugins = require('../../dd-trace/src/llmobs/plugins/google-adk')
const tracingPlugins = require('./tracing')

const plugins = {}

for (const Plugin of llmobsPlugins) {
  plugins[Plugin.id] = Plugin
}

for (const Plugin of tracingPlugins) {
  plugins[Plugin.id] = Plugin
}

class GoogleAdkPlugin extends CompositePlugin {
  static id = 'google-adk'
  static plugins = plugins
}

module.exports = GoogleAdkPlugin
