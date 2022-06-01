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

    const ddbEndpoint = new AWS.Endpoint('http://127.0.0.1:4569')
    const kinesisEndpoint = new AWS.Endpoint('http://127.0.0.1:4568')
    const s3Endpoint = new AWS.Endpoint('http://127.0.0.1:4572')
    const sqsEndpoint = new AWS.Endpoint('http://127.0.0.1:4576')
    const snsEndpoint = new AWS.Endpoint('http://127.0.0.1:4575')
    const route53Endpoint = new AWS.Endpoint('http://127.0.0.1:4580')
    const redshiftEndpoint = new AWS.Endpoint('http://127.0.0.1:4577')
    const lambdaEndpoint = new AWS.Endpoint('http://127.0.0.1:4566')

    const ddb = new AWS.DynamoDB({ endpoint: ddbEndpoint })
    const kinesis = new AWS.Kinesis({ endpoint: kinesisEndpoint })
    const route53 = new AWS.Route53({ endpoint: route53Endpoint })
    const s3 = new AWS.S3({ endpoint: s3Endpoint, s3ForcePathStyle: true })
    const sqs = new AWS.SQS({ endpoint: sqsEndpoint })
    const sns = new AWS.SNS({ endpoint: snsEndpoint })
    const redshift = new AWS.Redshift({ endpoint: redshiftEndpoint })
    const lambda = new AWS.Lambda({ endpoint: lambdaEndpoint })

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
