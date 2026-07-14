'use strict'

const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')
const processTags = require('../process-tags')

/**
 * Derives the tags array for the runtime-metrics DogStatsD client from the current config.
 * Shared by `createMetricsClient` and `updateTags` so they can't drift apart.
 *
 * Process tags are applied here, not via config/generateClientConfig, so they only
 * reach this bounded set of runtime metrics. Putting them on the global tags would
 * also tag user-facing custom metrics, inflating their cardinality (and billing).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {string[]}
 */
function generateMetricsClientTags (config) {
  const { tags } = DogStatsDClient.generateClientConfig(config)

  if (config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED) {
    for (const tag of processTags.tagsArray) {
      tags.push(tag)
    }
  }

  return tags
}

/**
 * Builds the aggregating DogStatsD client used to emit DD-proprietary tracer
 * metrics (runtime.node.*, datadog.tracer.*).
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {MetricsAggregationClient}
 */
function createMetricsClient (config) {
  const clientConfig = DogStatsDClient.generateClientConfig(config)
  clientConfig.tags = generateMetricsClientTags(config)

  return new MetricsAggregationClient(new DogStatsDClient(clientConfig))
}

module.exports = { createMetricsClient, generateMetricsClientTags }
