'use strict'

const axios = require('axios')
const RetryOperation = require('../operation')

function waitForCouchbase () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('couchbase')
    const ftsEndpoint = 'http://localhost:8094/api/index/test/query'

    operation.attempt(currentAttempt => {
      axios({
        method: 'POST',
        url: ftsEndpoint,
        data: {
          'ctl': {
            'timeout': 75000
          },
          'indexName': 'test',
          'query': {
            'query': 'eiffel'
          }
        },
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
