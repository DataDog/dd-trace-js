'use strict'

const RetryOperation = require('../operation')
const pg = require('../../../../../versions/pg').get()

function waitForPostgres () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('postgres')

    operation.attempt(currentAttempt => {
      const client = new pg.Client({
        user: 'postgres',
        password: 'postgres',
        database: 'postgres',
        application_name: 'test'
      })

      client.connect((err) => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        client.query('SELECT version()', (err, result) => {
          if (operation.retry(err)) return
          if (err) return reject(err)

          client.end((err) => {
            if (operation.retry(err)) return
            if (err) return reject(err)

            resolve()
          })
        })
      })
    })
  })
}

module.exports = waitForPostgres
