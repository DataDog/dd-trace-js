'use strict'

const { channel } = require('dc-polyfill')
const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')
const processTags = require('../process-tags')

const identityRefreshChannel = channel('datadog:identity:refresh')

/**
 * Builds the DogStatsD tags (with process tags applied) for the runtime-metrics client.
 * Shared by `createMetricsClient()` and `subscribeToIdentityRefresh()` so their tag
 * composition can't drift apart.
 *
 * Process tags are applied here, not via config/generateClientConfig, so they only
 * reach this bounded set of runtime metrics. Putting them on the global tags would
 * also tag user-facing custom metrics, inflating their cardinality (and billing).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {{ host: string, port: number, tags: string[], lookup: Function, metricsProxyUrl?: URL }}
 */
function buildClientConfig (config) {
  const clientConfig = DogStatsDClient.generateClientConfig(config)

  if (config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED) {
    for (const tag of processTags.tagsArray) {
      clientConfig.tags.push(tag)
    }
  }

  return clientConfig
}

/**
 * Builds the aggregating DogStatsD client used to emit DD-proprietary tracer
 * metrics (runtime.node.*, datadog.tracer.*). Shared by both runtime-metrics
 * paths (DogStatsD and OTLP) so their client construction can't drift apart.
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {MetricsAggregationClient}
 */
function createMetricsClient (config) {
  return new MetricsAggregationClient(new DogStatsDClient(buildClientConfig(config)))
}

/**
 * Subscribes a runtime-metrics client to the identity-refresh channel so its DogStatsD tags
 * (runtime-id, RC client id) reflect `config.tags` after a MicroVM clone resume.
 *
 * @param {MetricsAggregationClient} client - The client returned by `createMetricsClient()`
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {() => void} Unsubscribe function; call it from the owning module's `stop()`
 */
function subscribeToIdentityRefresh (client, config) {
  const onIdentityRefresh = () => {
    client.updateTags(buildClientConfig(config).tags)
  }
  identityRefreshChannel.subscribe(onIdentityRefresh)
  return () => identityRefreshChannel.unsubscribe(onIdentityRefresh)
}

module.exports = { createMetricsClient, subscribeToIdentityRefresh }
