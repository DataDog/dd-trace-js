'use strict'

/**
 * Retrieve the Kafka cluster ID from the admin API.
 * Returns a cached value, a promise, or null if unavailable.
 *
 * @param {object} kafka - KafkaJS-compatible Kafka instance
 * @returns {string|Promise<string>|null}
 */
function getKafkaClusterId (kafka) {
  if (kafka._ddKafkaClusterId) {
    return kafka._ddKafkaClusterId
  }

  if (!kafka.admin) {
    return null
  }

  const admin = kafka.admin()

  if (!admin.describeCluster) {
    return null
  }

  return admin.connect()
    .then(() => {
      return admin.describeCluster()
    })
    .then((clusterInfo) => {
      const clusterId = clusterInfo?.clusterId
      kafka._ddKafkaClusterId = clusterId
      admin.disconnect()
      return clusterId
    })
    .catch((error) => {
      throw error
    })
}

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

module.exports = {
  getKafkaClusterId,
  isPromise,
}
