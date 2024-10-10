'use strict'

const log = require('../../log')
const OpenAIIntegration = require('./openai')

const plugins = {}

// TODO(sam.brenner) should we be using the tracer here instead of passing the span?
function handleSpanStart ({ span, integration, resource, inputs, parent }) {
  log.debug('Handling span start for integration:', integration)
  const plugin = plugins[integration]
  if (plugin) plugin.setSpanStartTags(span, parent, resource, inputs)
}

function handleSpanEnd ({ span, integration, resource, response, error }) {
  log.debug('Handling span end for integration:', integration)
  const plugin = plugins[integration]
  if (plugin) plugin.setSpanEndTags(span, resource, response, error)
}

function handleSpanError ({ span, integration, resource, error }) {}

function registerPlugins (config) {
  log.debug('Registering LLM Observability plugins')
  plugins.openai = new OpenAIIntegration(config)
}

module.exports = { handleSpanStart, handleSpanEnd, handleSpanError, registerPlugins }
