'use strict'

const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')

/**
 * Builds the aggregating DogStatsD client used to emit DD-proprietary tracer
 * metrics (runtime.node.*, datadog.tracer.*). Shared by both runtime-metrics
 * paths (DogStatsD and OTLP) so their client construction can't drift apart.
 *
 * Process tags are applied here rather than in DogStatsDClient.generateClientConfig
 * so they only tag runtime metrics, not user-facing custom metrics (CustomMetrics
 * uses generateClientConfig directly and must keep its existing tag behavior).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {MetricsAggregationClient}
 */
function createMetricsClient (config) {
  const clientConfig = DogStatsDClient.generateClientConfig(config)

  if (config.dogstatsd.processTags) {
    for (const tag of config.dogstatsd.processTags) {
      clientConfig.tags.push(tag)
    }
  }

  return new MetricsAggregationClient(new DogStatsDClient(clientConfig))
}

module.exports = { createMetricsClient }
