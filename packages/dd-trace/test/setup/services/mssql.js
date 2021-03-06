'use strict'

const RetryOperation = require('../operation')
const tedious = require('../../../../../versions/tedious').get()

function waitForMssql () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('mssql')

    operation.attempt(currentAttempt => {
      const connection = new tedious.Connection({
        server: 'localhost',
        options: {
          trustServerCertificate: true
        },
        authentication: {
          options: {
            userName: 'sa',
            password: 'DD_HUNTER2'
          },
          type: 'default'
        }
      }).on('connect', err => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        // Create a stored procedure for tests
        const storedProc = 'CREATE OR ALTER PROCEDURE dbo.ddTestProc @num INT AS SELECT @num + 1 GO;'
        const request = new tedious.Request(storedProc, (err) => {
          connection.close()
          if (err) reject(err)
          else resolve()
        })

        connection.execSql(request)
      })
      connection.connect()
    })
  })
}

module.exports = waitForMssql
