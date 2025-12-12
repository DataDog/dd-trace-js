'use strict'

require('./http/client')
// Load push plugin BEFORE HTTP server so it subscribes to channel first
// (google-cloud-pubsub-push.js auto-initializes when DD_SERVERLESS_PUBSUB_ENABLED=true)
require('./google-cloud-pubsub-push')

require('./http/server')
