'use strict'

const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')
const processTags = require('../process-tags')

/**
 * Builds the aggregating DogStatsD client used to emit DD-proprietary tracer
 * metrics (runtime.node.*, datadog.tracer.*). Shared by both runtime-metrics
 * paths (DogStatsD and OTLP) so their client construction can't drift apart.
 *
 * Process tags are applied here, not via config/generateClientConfig, so they only
 * reach this bounded set of runtime metrics. Putting them on the global tags would
 * also tag user-facing custom metrics, inflating their cardinality (and billing).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {MetricsAggregationClient}
 */
function createMetricsClient (config) {
  const clientConfig = DogStatsDClient.generateClientConfig(config)

  if (config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED) {
    for (const tag of processTags.tagsArray) {
      clientConfig.tags.push(tag)
    }
  }

  return new MetricsAggregationClient(new DogStatsDClient(clientConfig))
}

module.exports = { createMetricsClient }
