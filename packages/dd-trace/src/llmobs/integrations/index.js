'use strict'

const OpenAIIntegration = require('./openai')

const plugins = {}

// TODO(sam.brenner) should we be using the tracer here instead of passing the span?
function handleSpanStart ({ span, integration, resource, inputs }) {
  const plugin = plugins[integration]
  if (plugin) plugin.setSpanStartTags(span, resource, inputs)
}

function handleSpanEnd ({ span, integration, resource, response, error }) {
  const plugin = plugins[integration]
  if (plugin) plugin.setSpanEndTags(span, resource, response, error)
}

function handleSpanError ({ span, integration, resource, error }) {}

function registerPlugins (config) {
  plugins.openai = new OpenAIIntegration(config)
}

module.exports = { handleSpanStart, handleSpanEnd, handleSpanError, registerPlugins }
