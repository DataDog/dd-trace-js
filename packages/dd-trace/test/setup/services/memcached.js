'use strict'

const RetryOperation = require('../operation')
const Memcached = require('../../../../../versions/memcached').get()

function waitForMemcached () {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const operation = new RetryOperation('memcached')

    operation.attempt(() => {
      const memcached = new Memcached('localhost:11211', { retries: 0 })

      memcached.version((err, version) => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        memcached.end()
        resolve()
      })
    })
  }))
}

module.exports = waitForMemcached
