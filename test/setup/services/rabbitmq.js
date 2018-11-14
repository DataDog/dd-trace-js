'use strict'

const RetryOperation = require('../operation')
const amqplib = require('../../../versions/amqplib').get('amqplib/callback_api')

function waitForRabbitMQ () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('rabbitmq')

    operation.attempt(currentAttempt => {
      amqplib
        .connect((err, conn) => {
          if (operation.retry(err)) return
          if (err) return reject(err)

          conn.close(() => resolve())
        })
    })
  })
}

module.exports = waitForRabbitMQ
