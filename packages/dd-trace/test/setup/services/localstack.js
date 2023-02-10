'use strict'

const RetryOperation = require('../operation')
process.env.AWS_SECRET_ACCESS_KEY = '0000000000/00000000000000000000000000000'
process.env.AWS_ACCESS_KEY_ID = '00000000000000000000'
const AWS = require('../../../../../versions/aws-sdk').get()

// TODO: figure out why CloudWatch Logs always returns an error

function waitForAWS () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('aws-sdk')

    // Set the region
    AWS.config.update({ region: 'us-east-1' })

    const endpoint = new AWS.Endpoint('http://127.0.0.1:4566')

    const ddb = new AWS.DynamoDB({ endpoint })
    const kinesis = new AWS.Kinesis({ endpoint })
    const route53 = new AWS.Route53({ endpoint })
    const s3 = new AWS.S3({ endpoint, s3ForcePathStyle: true })
    const sqs = new AWS.SQS({ endpoint })
    const sns = new AWS.SNS({ endpoint })
    const redshift = new AWS.Redshift({ endpoint })
    const lambda = new AWS.Lambda({ endpoint })

    operation.attempt(currentAttempt => {
      Promise.all([
        ddb.listTables({}).promise(),
        kinesis.listStreams({}).promise(),
        s3.listBuckets({}).promise(),
        sqs.listQueues({}).promise(),
        sns.listTopics({}).promise(),
        route53.listHealthChecks({}).promise(),
        redshift.describeClusters({}).promise(),
        lambda.listFunctions({}).promise()
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
