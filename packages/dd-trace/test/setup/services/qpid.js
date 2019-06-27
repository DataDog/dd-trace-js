'use strict'

const RetryOperation = require('../operation')
const amqp = require('../../../../../versions/amqp10').get()

function waitForQpid () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('qpid')

    operation.attempt(currentAttempt => {
      const client = new amqp.Client(amqp.Policy.merge({
        reconnect: null
      }))

      client.connect('amqp://admin:admin@localhost:5673')
        .then(() => client.disconnect())
        .then(() => resolve())
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

module.exports = waitForQpid
