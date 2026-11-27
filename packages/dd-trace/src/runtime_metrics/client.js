'use strict'

const { channel } = require('dc-polyfill')
const { DogStatsDClient, createMetricsAggregationClient } = require('../dogstatsd')
const processTags = require('../process-tags')

const configUpdateChannel = channel('datadog:config:update')

/**
 * Builds the DogStatsD tags (with process tags applied) for the runtime-metrics client.
 * Shared by `createMetricsClient()` and `subscribeToConfigUpdates()` so their tag
 * composition can't drift apart.
 *
 * Process tags are applied here, not via config/generateClientConfig, so they only
 * reach this bounded set of runtime metrics. Putting them on the global tags would
 * also tag user-facing custom metrics, inflating their cardinality (and billing).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {import('../dogstatsd').DogStatsDClientOptions}
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
 * @returns {ReturnType<typeof createMetricsAggregationClient>}
 */
function createMetricsClient (config) {
  return createMetricsAggregationClient(buildClientConfig(config))
}

/**
 * Subscribes a runtime-metrics client to the config-update channel so its DogStatsD tags
 * (runtime-id, RC client id) reflect `config.tags` after a MicroVM clone resume.
 *
 * @param {ReturnType<typeof createMetricsAggregationClient>} client - The client returned by `createMetricsClient()`
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {() => void} Unsubscribe function; call it from the owning module's `stop()`
 */
function subscribeToConfigUpdates (client, config) {
  const onConfigUpdate = () => client.configure(buildClientConfig(config))
  configUpdateChannel.subscribe(onConfigUpdate)
  return () => configUpdateChannel.unsubscribe(onConfigUpdate)
}

module.exports = { createMetricsClient, subscribeToConfigUpdates }
