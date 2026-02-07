'use strict'

const RetryOperation = require('../operation')
const mongo = require('../../../../../versions/mongodb-core').get()
const waitForMongoReplicaSet = require('./mongo-replica-set')

const REPLICA_SET_PARAM = 'replicaSet'

/**
 * @typedef {import('events').EventEmitter & {
 *   connect: () => void,
 *   destroy: () => void,
 * }} MongoCoreServer
 */

function shouldInitiateReplicaSet () {
  const url = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.searchParams.has(REPLICA_SET_PARAM)
  } catch {
    return false
  }
}

/**
 * @returns {Promise<void>}
 */
function connectMongoCore () {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const server = /** @type {MongoCoreServer} */ (/** @type {unknown} */ (new mongo.Server({
      host: '127.0.0.1',
      port: 27017,
      reconnect: false,
    })))

    server.on('connect', () => {
      server.destroy()
      resolve(undefined)
    })

    server.on('error', err => {
      server.destroy()
      reject(err)
    })

    server.connect()
  }))
}

function waitForMongo () {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const operation = new RetryOperation('mongo')

    operation.attempt(async () => {
      try {
        await connectMongoCore()
        if (shouldInitiateReplicaSet()) {
          await waitForMongoReplicaSet()
        }
        resolve(undefined)
      } catch (error) {
        if (operation.retry(error)) return
        reject(error)
      }
    })
  }))
}

module.exports = waitForMongo
