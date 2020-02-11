'use strict'

const RetryOperation = require('../operation')
const { AWS } = require('../../../../../versions/@google-cloud/pubsub').get()

function waitforAWS () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('aws-sdk')

    const ep_dynamo = new AWS.Endpoint('http://localhost:4569');
    const ep_kinesis = new AWS.Endpoint('http://localhost:4568');
    const ep_s3 = new AWS.Endpoint('http://localhost:4572');

    // Set the region 
    AWS.config.update({region: 'REGION'});

    const ddb = new AWS.DynamoDB({endpoint: ep_dynamo});
    const kinesis = new AWS.Kinesis({endpoint: ep_kinesis});
    const s3 = new AWS.Kinesis({endpoint: ep_s3, s3ForcePathStyle: true});

    operation.attempt(currentAttempt => {

      Promise.all[ddb.listTables({}).promise(),kinesis.listStreams({}).promise(), s3.listBuckets({})].then( data => {
        resolve()
      }).catch( err => {
        if (operation.retry(err)) return
        if (err) return reject(err)
      })

    })
  })
}

module.exports = waitForAWS
