'use strict'

const RetryOperation = require('../operation')
const { AWS } = require('../../../../../versions/aws-sdk').get()

function waitForAWS () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('aws-sdk')

    const epDynamo = new AWS.Endpoint('http://localhost:4569')
    const epKinesis = new AWS.Endpoint('http://localhost:4568')
    const epS3 = new AWS.Endpoint('http://localhost:4572')
    const epSqs = new AWS.Endpoint('http://localhost:4576')
    const epSns = new AWS.Endpoint('http://localhost:4575')

    // Set the region
    AWS.config.update({ region: 'us-east-1' })

    const ddb = new AWS.DynamoDB({ endpoint: epDynamo })
    const kinesis = new AWS.Kinesis({ endpoint: epKinesis })
    const s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
    const sqs = new AWS.SQS({ endpoint: epSqs })
    const sns = new AWS.SQS({ endpoint: epSns })

    operation.attempt(currentAttempt => {
      Promise.all([
        ddb.listTables({}).promise(),
        kinesis.listStreams({}).promise(),
        s3.listBuckets({}).promise(),
        sqs.listQueues({}).promise(),
        sns.listTopics({}).promise()
      ]).then(data => {
        resolve()
      }).catch(err => {
        if (operation.retry(err)) return
        if (err) return reject(err)
      })
    })
  })
}

module.exports = waitForAWS
