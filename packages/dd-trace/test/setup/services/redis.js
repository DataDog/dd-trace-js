'use strict'

const RetryOperation = require('../operation')
const redis = require('../../../../../versions/redis').get()

function waitForRedis () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('redis')

    operation.attempt(currentAttempt => {
      const client = redis.createClient({
        port: 16379,
        retry_strategy: options => {
          if (operation.retry(options.error)) return
          reject(options.error)
        }
      })

      client.on('connect', (a) => {
        client.quit()
        resolve()
      })
    })
  })
}

module.exports = waitForRedis
