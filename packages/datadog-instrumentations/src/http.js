'use strict'

try {
  // Load the Pub/Sub Transit Handler plugin directly to ensure it gets instantiated
  const TransitHandlerPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-transit-handler')
  const tracer = require('../../dd-trace')
  if (tracer && tracer._tracer && !global._dd_gcp_pubsub_transit_handler) {
    // Keep a reference to avoid GC and satisfy no-new side-effect rule
    global._dd_gcp_pubsub_transit_handler = new TransitHandlerPlugin(tracer._tracer)
  }
} catch {
  // Silently handle plugin loading errors
}

require('./http/client')
require('./http/server')
