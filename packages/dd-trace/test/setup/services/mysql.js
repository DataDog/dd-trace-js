'use strict'

const RetryOperation = require('../operation')
const mysql = require('../../../../../versions/mysql').get()

function waitForMysql () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('mysql')

    operation.attempt(currentAttempt => {
      const connection = mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        database: 'db'
      })

      connection.connect(err => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        connection.end(() => resolve())
      })
    })
  })
}

module.exports = waitForMysql
