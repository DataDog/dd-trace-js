'use strict'

const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
const HttpServerPlugin = require('./server')
const HttpClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const { enableGCPPubSubPushSubscription } = require('../../dd-trace/src/serverless')
const log = require('../../dd-trace/src/log')

/**
 * HTTP Plugin loads server/client plugins with optional GCP Pub/Sub Push support.
 * Plugin order is critical: PushSubscriptionPlugin must load FIRST to intercept
 * Pub/Sub push requests and activate delivery spans before HTTP spans are created.
 */
class HttpPlugin extends CompositePlugin {
  static id = 'http'
  static get plugins () {
    const plugins = {}

    console.log('[DEBUG HTTP PLUGIN] Getting plugins, K_SERVICE =', process.env.K_SERVICE)
    console.log('[DEBUG HTTP PLUGIN] enableGCPPubSubPushSubscription() =', enableGCPPubSubPushSubscription())
    console.log('[DEBUG HTTP PLUGIN] PushSubscriptionPlugin =', typeof PushSubscriptionPlugin, PushSubscriptionPlugin)

    // Load push subscription plugin first (if enabled) for GCP Cloud Run
    if (enableGCPPubSubPushSubscription()) {
      try {
        plugins['pubsub-push-subscription'] = PushSubscriptionPlugin
        console.log('[DEBUG HTTP PLUGIN] Added pubsub-push-subscription plugin')
        log.debug('Loaded GCP Pub/Sub Push Subscription plugin for HTTP requests')
      } catch (e) {
        console.log('[DEBUG HTTP PLUGIN] Failed to load:', e.message, e.stack)
        log.debug(`Failed to load GCP Pub/Sub Push Subscription plugin: ${e.message}`)
      }
    }

    plugins.server = HttpServerPlugin
    plugins.client = HttpClientPlugin

    console.log('[DEBUG HTTP PLUGIN] Returning plugins:', Object.keys(plugins))
    return plugins
  }
}

module.exports = HttpPlugin
