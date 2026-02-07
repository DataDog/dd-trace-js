'use strict'

const RetryOperation = require('../operation')
const mongodb = require('../../../../../versions/mongodb').get()

const REPLICA_SET_NAME = 'rs0'
const ADMIN_URI = 'mongodb://127.0.0.1:27017/admin?directConnection=true'
const REPLICA_SET_CONFIG = {
  _id: REPLICA_SET_NAME,
  members: [{ _id: 0, host: '127.0.0.1:27017' }],
}

function isAlreadyInitialized (error) {
  return error?.code === 23 ||
    error?.codeName === 'AlreadyInitialized' ||
    /already\s+initialized/i.test(error?.message || '')
}

/**
 * @returns {Promise<void>}
 */
function waitForMongoReplicaSet () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('mongo-replset')

    operation.attempt(async () => {
      const client = new mongodb.MongoClient(ADMIN_URI)
      try {
        await client.connect()
        const admin = client.db('admin')
        try {
          await admin.command({ replSetInitiate: REPLICA_SET_CONFIG })
        } catch (error) {
          if (!isAlreadyInitialized(error)) throw error
        }
        const status = await admin.command({ replSetGetStatus: 1 })
        if (status?.myState !== 1) {
          throw new Error('Replica set not ready')
        }
        resolve()
      } catch (error) {
        if (operation.retry(error)) return
        reject(error)
      } finally {
        await client.close().catch(() => {})
      }
    })
  })
}

module.exports = waitForMongoReplicaSet
