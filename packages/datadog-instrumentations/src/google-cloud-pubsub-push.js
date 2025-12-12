'use strict'

// Mock module for push subscription plugin
// Auto-initializes when required if DD_SERVERLESS_PUBSUB_ENABLED=true

const { enableServerlessPubsubSubscription } = require('../../dd-trace/src/serverless')
const log = require('../../dd-trace/src/log')
let initialized = false

function init () {
  if (initialized || !enableServerlessPubsubSubscription()) {
    return
  }

  try {
    const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
    const plugin = new PushSubscriptionPlugin(null, {})
    plugin.configure({})
    initialized = true
  } catch (e) {
    log.debug(`PushSubscriptionPlugin not loaded: ${e.message}`)
  }
}

// Auto-init when module is required (if enabled)
init()

module.exports = { init }
