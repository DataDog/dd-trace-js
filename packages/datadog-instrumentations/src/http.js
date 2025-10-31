'use strict'

// Initialize transit handler after a delay to ensure tracer is ready
setImmediate(() => {
  try {
    const TransitHandlerPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-transit-handler')
    const tracer = require('../../dd-trace')

    if (tracer && tracer._tracer && !global._dd_gcp_pubsub_transit_handler) {
      global._dd_gcp_pubsub_transit_handler = new TransitHandlerPlugin(tracer._tracer)
    }
  } catch {}
})

require('./http/client')
require('./http/server')
