'use strict'

const axios = require('axios')
const RetryOperation = require('../operation')

function waitForCouchbase () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('couchbase')
    const n1qlEndpoint = 'http://127.0.0.1:8093/query/service'

    operation.attempt(currentAttempt => {
      axios({
        method: 'POST',
        url: n1qlEndpoint,
        data: { statement: 'SELECT * FROM system:keyspaces WHERE name="datadog-test"' },
        auth: {
          username: 'Administrator',
          password: 'password',
        },
      })
        .then(response => {
          if (!response.data.results?.length) {
            operation.retry(new Error('datadog-test keyspace not ready'))
          } else {
            resolve()
          }
        })
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

module.exports = waitForCouchbase
