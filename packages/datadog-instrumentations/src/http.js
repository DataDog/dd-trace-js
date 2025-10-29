'use strict'

// Initialize transit handler after a delay to ensure tracer is ready
setImmediate(() => {
  try {
    const TransitHandlerPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-transit-handler')
    const tracer = require('../../dd-trace')
    
    if (tracer && tracer._tracer && !global._dd_gcp_pubsub_transit_handler) {
      global._dd_gcp_pubsub_transit_handler = new TransitHandlerPlugin(tracer._tracer)
    }
  } catch (err) {
    // Silently fail - transit handler is optional
  }
})

require('./http/client')
require('./http/server')
