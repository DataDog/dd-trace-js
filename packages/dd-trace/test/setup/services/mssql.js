'use strict'

const RetryOperation = require('../operation')
const tedious = require('../../../../../versions/tedious').get()

function waitForMssql () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('mysql')

    operation.attempt(currentAttempt => {
      const connection = new tedious.Connection({
        server: 'localhost',
        userName: 'sa',
        password: 'DD_HUNTER2'
      }).on('connect', err => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        connection.on('end', () => resolve())
        connection.close()
      })
    })
  })
}

module.exports = waitForMssql
