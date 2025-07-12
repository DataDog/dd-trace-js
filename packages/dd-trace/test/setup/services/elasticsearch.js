'use strict'

const axios = require('axios')
const RetryOperation = require('../operation')

function waitForElasticsearch () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('elasticsearch')

    operation.attempt(currentAttempt => {
      // Not using ES client because it's buggy for initial connection.
      axios.get('http://127.0.0.1:9200/_cluster/health?wait_for_status=green&local=true&timeout=100ms')
        .then(() => resolve())
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

module.exports = waitForElasticsearch
