'use strict'

const { once } = require('events')

const RetryOperation = require('../operation')

const REPLICA_SET_NAME = 'rs0'
const ADMIN_NS = 'admin.$cmd'
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
 * @typedef {import('events').EventEmitter & {
 *   connect: () => void,
 *   destroy: () => void,
 *   command: (
 *     ns: string,
 *     cmd: object,
 *     options: object,
 *     cb: (err?: Error, res?: { result?: { myState?: number } }) => void
 *   ) => void
 * }} MongoCoreServer
 */

/**
 * @param {MongoCoreServer} server
 * @param {object} command
 * @returns {Promise<{ myState?: number }|undefined>}
 */
function commandMongoCore (server, command) {
  return new Promise((resolve, reject) => {
    server.command(ADMIN_NS, command, {}, (err, res) => {
      if (err) return reject(err)
      resolve(res?.result)
    })
  })
}

/**
 * @returns {Promise<void>}
 */
function waitForMongoReplicaSet (isSandbox) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const mongoCore = isSandbox ? require('mongodb-core') : require('../../../../../versions/mongodb-core').get()

    const operation = new RetryOperation('mongo-replset')

    operation.attempt(async () => {
      const Server = /** @type {new (options: object) => MongoCoreServer} */ (/** @type {unknown} */ (mongoCore.Server))
      const server = /** @type {MongoCoreServer} */ (/** @type {unknown} */ (new Server({
        host: '127.0.0.1',
        port: 27017,
        reconnect: false,
        monitoring: false,
      })))

      try {
        server.connect()
        await once(server, 'connect')

        try {
          await commandMongoCore(server, { replSetInitiate: REPLICA_SET_CONFIG })
        } catch (error) {
          if (!isAlreadyInitialized(error)) throw error
        }

        const status = await commandMongoCore(server, { replSetGetStatus: 1 })
        if (status?.myState !== 1) throw new Error('Replica set not ready')

        resolve()
      } catch (error) {
        if (operation.retry(error)) return
        reject(error)
      } finally {
        server.destroy()
      }
    })
  }))
}

module.exports = waitForMongoReplicaSet
