'use strict'

const RetryOperation = require('../operation')
process.env.AWS_SECRET_ACCESS_KEY = '0000000000/00000000000000000000000000000'
process.env.AWS_ACCESS_KEY_ID = '00000000000000000000'
const { AWS } = require('../../../../../versions/aws-sdk').get()

function waitForAWS () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('aws-sdk')

    const epDynamo = new AWS.Endpoint('http://localhost:4569')
    const epKinesis = new AWS.Endpoint('http://localhost:4568')
    const epS3 = new AWS.Endpoint('http://localhost:4572')
    const epSqs = new AWS.Endpoint('http://localhost:4576')
    const epSns = new AWS.Endpoint('http://localhost:4575')
    const epRoute53 = new AWS.Endpoint('http://localhost:4580')
    const epCwLogs = new AWS.Endpoint('http://localhost:4586')
    const epRedshift = new AWS.Endpoint('http://localhost:4577')

    // Set the region
    AWS.config.update({ region: 'us-east-1' })

    const ddb = new AWS.DynamoDB({ endpoint: epDynamo })
    const kinesis = new AWS.Kinesis({ endpoint: epKinesis })
    const route53 = new AWS.Route53({ endpoint: epRoute53 })
    const s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
    const sqs = new AWS.SQS({ endpoint: epSqs })
    const sns = new AWS.SQS({ endpoint: epSns })
    const cwLogs = new AWS.SQS({ endpoint: epCwLogs })
    const redshift = new AWS.Redshift({ endpoint: epRedshift })

    operation.attempt(currentAttempt => {
      Promise.all([
        ddb.listTables({}).promise(),
        kinesis.listStreams({}).promise(),
        s3.listBuckets({}).promise(),
        sqs.listQueues({}).promise(),
        sns.listTopics({}).promise(),
        route53.listHealthChecks({}).promise(),
        cwLogs.describeDestinations({}).promise(),
        redshift.describeClusters({}).promise()
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
