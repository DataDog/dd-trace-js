'use strict'

const RetryOperation = require('../operation')
const httpRequest = require('../helpers/http-client')

function waitForElasticsearch () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('elasticsearch')

    operation.attempt(currentAttempt => {
      // Not using ES client because it's buggy for initial connection.
      httpRequest.get('http://127.0.0.1:9200/_cluster/health?wait_for_status=green&local=true&timeout=100ms')
        .then(() => resolve())
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

module.exports = waitForElasticsearch
