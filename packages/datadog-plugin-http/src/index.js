'use strict'

const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const { enableGCPPubSubPushSubscription } = require('../../dd-trace/src/serverless')
const log = require('../../dd-trace/src/log')
const HttpClientPlugin = require('./client')
const HttpServerPlugin = require('./server')

/**
 * HTTP Plugin loads server/client plugins with optional GCP Pub/Sub Push support.
 * Plugin order is critical: PushSubscriptionPlugin must load FIRST to intercept
 * Pub/Sub push requests and activate delivery spans before HTTP spans are created.
 */
class HttpPlugin extends CompositePlugin {
  static id = 'http'
  static get plugins () {
    const plugins = {}

    // Load push subscription plugin first (if enabled) for GCP Cloud Run
    if (enableGCPPubSubPushSubscription()) {
      try {
        plugins['pubsub-push-subscription'] = PushSubscriptionPlugin
        log.debug('Loaded GCP Pub/Sub Push Subscription plugin for HTTP requests')
      } catch (e) {
        log.debug(`Failed to load GCP Pub/Sub Push Subscription plugin: ${e.message}`)
      }
    }

    plugins.server = HttpServerPlugin
    plugins.client = HttpClientPlugin

    return plugins
  }
}

module.exports = HttpPlugin
