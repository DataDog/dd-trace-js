'use strict'

const RetryOperation = require('../operation')
const { AWS } = require('../../../../../versions/@google-cloud/pubsub').get()

function waitforAWS () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('aws-sdk')

    var ep_dynamo = new AWS.Endpoint('http://localhost:4569');

    // Set the region 
    AWS.config.update({region: 'REGION'});

    var ddb = new AWS.DynamoDB({apiVersion: '2012-08-10', endpoint: ep_dynamo});

    console.log('did that work', ddb)
    operation.attempt(currentAttempt => {
      console.log('oh?', currentAttempt)
      ddb.listTables({}, (err, data) => {
        if (operation.retry(err)) return
        if (err) return reject(err)
        resolve()
      })

    })
  })
}

module.exports = waitForAWS
