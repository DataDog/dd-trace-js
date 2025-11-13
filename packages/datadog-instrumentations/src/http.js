'use strict'

require('./http/client')
// Load google-cloud-pubsub instrumentation before server to ensure transit handler
// is available for push subscriptions (even when SDK not imported)
require('./google-cloud-pubsub')
require('./http/server')
