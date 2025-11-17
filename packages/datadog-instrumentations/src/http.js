'use strict'

require('./http/client')

// Auto-load push subscription plugin to enable pubsub.delivery spans for push subscriptions
// The plugin intercepts HTTP requests from Google Cloud Pub/Sub push endpoints
try {
  const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
  new PushSubscriptionPlugin(null, {}).configure({})
} catch {
  // Push subscription plugin is optional
}

require('./http/server')
