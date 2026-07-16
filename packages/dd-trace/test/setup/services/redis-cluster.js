'use strict'

const RetryOperation = require('../operation')
const ioredis = require('../../../../../versions/ioredis').get()

const CLUSTER_NODES = [{ host: '127.0.0.1', port: 7000 }]

function waitForRedisCluster () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('redis-cluster')

    operation.attempt(() => {
      const cluster = new ioredis.Cluster(CLUSTER_NODES, {
        clusterRetryStrategy: () => undefined,
      })

      cluster.once('ready', () => {
        cluster.disconnect()
        resolve()
      })

      cluster.once('error', (error) => {
        cluster.disconnect()
        if (operation.retry(error)) return
        reject(error)
      })
    })
  })
}

module.exports = waitForRedisCluster
