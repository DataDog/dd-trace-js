'use strict'

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

    // Load the push subscription plugin first (if enabled) for GCP Cloud Run.
    // The require stays inside the gate so the pubsub plugin graph is not pulled
    // into every process that instruments http — only GCP Cloud Run reaches it.
    if (enableGCPPubSubPushSubscription()) {
      plugins['pubsub-push-subscription'] =
        require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
      log.debug('Loaded GCP Pub/Sub Push Subscription plugin for HTTP requests')
    }

    plugins.server = HttpServerPlugin
    plugins.client = HttpClientPlugin

    return plugins
  }
}

module.exports = HttpPlugin
