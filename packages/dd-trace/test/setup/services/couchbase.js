'use strict'

const axios = require('axios')
const RetryOperation = require('../operation')

function waitForCouchbase () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('couchbase')
    const cbasEndpoint = 'http://127.0.0.1:8095/query/service'

    operation.attempt(currentAttempt => {
      axios({
        method: 'POST',
        url: cbasEndpoint,
        data: { statement: 'SELECT * FROM datatest', timeout: '75000000us' },
        auth: {
          username: 'Administrator',
          password: 'password'
        }
      })
        .then(() => resolve())
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

module.exports = waitForCouchbase
