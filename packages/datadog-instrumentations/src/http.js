'use strict'

try {
  // Load the HttpHandler plugin directly to ensure it gets instantiated
  const HttpHandlerPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/http-handler')

  // Get tracer instance and instantiate the plugin
  const tracer = require('../../dd-trace')
  if (tracer && tracer._tracer) {
    new HttpHandlerPlugin(tracer) // eslint-disable-line no-new
  }
} catch {
  // Silently handle plugin loading errors
}

require('./http/client')
require('./http/server')
