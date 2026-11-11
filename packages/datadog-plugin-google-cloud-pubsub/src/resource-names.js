'use strict'

// Full resource names: https://cloud.google.com/pubsub/docs/pubsub-basics#resource_names
// Project IDs never contain braces; the client library uses `{{projectId}}` until it resolved the project.
const TOPIC_NAME = /^projects\/[^/{}]+\/topics\/[^/]+$/
const SUBSCRIPTION_NAME = /^projects\/[^/{}]+\/subscriptions\/[^/]+$/

/**
 * @param {unknown} value
 * @returns {string | undefined} `value` when it is a full `projects/<project>/topics/<topic>` name.
 */
function getTopicName (value) {
  return typeof value === 'string' && TOPIC_NAME.test(value) ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {string | undefined} `value` when it is a full `projects/<project>/subscriptions/<subscription>` name.
 */
function getSubscriptionName (value) {
  return typeof value === 'string' && SUBSCRIPTION_NAME.test(value) ? value : undefined
}

module.exports = { getSubscriptionName, getTopicName }
