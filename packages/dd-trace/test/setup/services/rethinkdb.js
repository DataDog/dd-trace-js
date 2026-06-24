'use strict'

const RetryOperation = require('../operation')
const r = require('../../../../../versions/rethinkdb').get()

function waitForRethinkDB () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('rethinkdb')

    operation.attempt(currentAttempt => {
      r.connect({ host: '127.0.0.1', port: 28015 }, (err, connection) => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        connection.close(closeErr => closeErr ? reject(closeErr) : resolve())
      })
    })
  })
}

module.exports = waitForRethinkDB
