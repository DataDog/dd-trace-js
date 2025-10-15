'use strict'

const { expect } = require('chai')
const { describe, it, before, after } = require('mocha')

const { promisify } = require('node:util')

const agent = require('../../dd-trace/test/plugins/agent')
const helpers = require('./kinesis_helpers')
const { setup } = require('./spec_helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('Serverless', function () {
    this.timeout(10000)
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS

      before(async () => {
        process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'agent'
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'test'
        await agent.load(['aws-sdk', 'http'], [{}, { server: false }])
      })

      after(async () => {
        delete process.env.DD_TRACE_EXPERIMENTAL_EXPORTER
        delete process.env.AWS_LAMBDA_FUNCTION_NAME
        await agent.close({ ritmReset: false })
      })

      describe('DynamoDB-Serverless', () => {
        let dynamo
        const tableName = 'PeerServiceTestTable'
        const dynamoClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-dynamodb' : 'aws-sdk'

        function getCreateTableParams () {
          return {
            TableName: tableName,
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
          }
        }

        before(async () => {
          AWS = require(`../../../versions/${dynamoClientName}@${version}`).get()

          dynamo = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

          // ignore error if the table already exists
          if (typeof dynamo.createTable === 'function') {
            const createTable = toPromise(dynamo, dynamo.createTable)
            try { await createTable(getCreateTableParams()) } catch (_) {}
          }
        })

        it('propagates peer.service from aws span to underlying http span', async () => {
          const send = toPromise(dynamo, dynamo.putItem)

          const tracesPromise = agent.assertSomeTraces(traces => {
            const peerService = 'dynamodb.us-east-1.amazonaws.com'
            const spans = traces[0]
            const awsSpan = spans.find(s => s.name === 'aws.request')
            const httpSpan = spans.find(s => s.name === 'http.request')
            expect(awsSpan.meta['peer.service']).to.equal(peerService)
            expect(httpSpan.meta['peer.service']).to.equal(peerService)
          }, { timeoutMs: 10000 })

          await Promise.all([
            tracesPromise,
            send({
              TableName: tableName,
              Item: {
                id: { S: '123' }
              }
            })
          ])
        })
      })

      describe('Kinesis-Serverless', () => {
        let kinesis
        const streamName = 'PeerStream'
        const kinesisClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-kinesis' : 'aws-sdk'

        function createStream (cb) {
          AWS = require(`../../../versions/${kinesisClientName}@${version}`).get()

          const params = {
            endpoint: 'http://127.0.0.1:4566',
            region: 'us-east-1'
          }

          if (moduleName === '@aws-sdk/smithy-client') {
            const { NodeHttpHandler } = require(`../../../versions/@aws-sdk/node-http-handler@${version}`).get()

            params.requestHandler = new NodeHttpHandler()
          }

          kinesis = new AWS.Kinesis(params)

          kinesis.createStream({
            StreamName: streamName,
            ShardCount: 1
          }, (err) => {
            if (err) return cb(err)

            helpers.waitForActiveStream(kinesis, streamName, cb)
          })
        }

        before(done => {
          createStream(done)
        })

        after(done => {
          kinesis.deleteStream({
            StreamName: streamName
          }, (err, res) => {
            if (err) return done(err)

            helpers.waitForDeletedStream(kinesis, streamName, done)
          })
        })

        it('propagates peer.service from aws span to underlying http span', done => {
          agent.assertSomeTraces(traces => {
            const peerService = 'kinesis.us-east-1.amazonaws.com'
            const spans = traces[0]
            const awsSpan = spans.find(s => s.name === 'aws.request')
            const httpSpan = spans.find(s => s.name === 'http.request')
            expect(awsSpan.meta['peer.service']).to.equal(peerService)
            expect(httpSpan.meta['peer.service']).to.equal(peerService)
          }, { timeoutMs: 10000 })
            .then(done, done)

          helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, e => e && done(e))
        })
      })

      describe('SNS-Serverless', () => {
        let sns, sqs, TopicArn, QueueUrl

        const queueName = 'PeerQueue'
        const topicName = 'PeerTopic'

        const snsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sns' : 'aws-sdk'
        const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

        function createTopicAndQueue (cb) {
          const { SNS } = require(`../../../versions/${snsClientName}@${version}`).get()
          const { SQS } = require(`../../../versions/${sqsClientName}@${version}`).get()

          sns = new SNS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs = new SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

          sns.createTopic({ Name: topicName }, (err, data) => {
            if (err) return cb(err)

            TopicArn = data.TopicArn

            sqs.createQueue({ QueueName: queueName }, (err, data) => {
              if (err) return cb(err)

              QueueUrl = data.QueueUrl

              sqs.getQueueAttributes({ QueueUrl, AttributeNames: ['All'] }, (err, data) => {
                if (err) return cb(err)

                cb()
              })
            })
          })
        }

        before(done => {
          createTopicAndQueue(done)
        })

        after(done => {
          sns.deleteTopic({ TopicArn }, done)
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        it('propagates peer.service from aws span to underlying http span', done => {
          agent.assertSomeTraces(traces => {
            const peerService = 'sns.us-east-1.amazonaws.com'
            const spans = traces[0]
            const awsSpan = spans.find(s => s.name === 'aws.request')
            const httpSpan = spans.find(s => s.name === 'http.request')
            expect(awsSpan.meta['peer.service']).to.equal(peerService)
            expect(httpSpan.meta['peer.service']).to.equal(peerService)
          }, { timeoutMs: 10000 })
            .then(done, done)

          sns.publish({
            TopicArn,
            Message: 'message 1',
            MessageAttributes: {
              baz: { DataType: 'String', StringValue: 'bar' },
              keyOne: { DataType: 'String', StringValue: 'keyOne' },
              keyTwo: { DataType: 'String', StringValue: 'keyTwo' }
            }
          }, e => e && done(e))
        })
      })

      describe('SQS-Serverless', () => {
        let sqs
        const queueName = 'SQS_QUEUE_NAME'

        const getQueueParams = (queueName) => {
          return {
            QueueName: queueName,
            Attributes: {
              MessageRetentionPeriod: '86400'
            }
          }
        }

        const queueOptions = getQueueParams(queueName)
        const QueueUrl = 'http://127.0.0.1:4566/00000000000000000000/SQS_QUEUE_NAME'

        const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptions, done)
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        it('propagates peer.service from aws span to underlying http span', done => {
          agent.assertSomeTraces(traces => {
            const peerService = 'sqs.us-east-1.amazonaws.com'
            const spans = traces[0]
            const awsSpan = spans.find(s => s.name === 'aws.request')
            const httpSpan = spans.find(s => s.name === 'http.request')
            expect(awsSpan.meta['peer.service']).to.equal(peerService)
            expect(httpSpan.meta['peer.service']).to.equal(peerService)
          }, { timeoutMs: 10000 })
            .then(done, done)

          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, () => {})
        })
      })

      describe('S3-Serverless', () => {
        let s3
        const bucketName = 's3-bucket-name-test'

        const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'

        before(done => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', s3ForcePathStyle: true, region: 'us-east-1' })

          if (s3ClientName === 'aws-sdk') {
            s3.api.globalEndpoint = '127.0.0.1'
          }

          s3.createBucket({ Bucket: bucketName }, done)
        })

        it('propagates peer.service from aws span to underlying http span', async () => {
          const put = toPromise(s3, s3.putObject)

          await put({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'dummy-data'
          })

          await agent.assertSomeTraces(traces => {
            const peerService = 's3-bucket-name-test.s3.us-east-1.amazonaws.com'
            const spans = traces[0]
            const awsSpan = spans.find(s => s.name === 'aws.request')
            const httpSpan = spans.find(s => s.name === 'http.request')
            expect(awsSpan.meta['peer.service']).to.equal(peerService)
            expect(httpSpan.meta['peer.service']).to.equal(peerService)
          }, { timeoutMs: 10000 })
        })
      })
    })
  })
})

function toPromise (client, fn) {
  return function (...args) {
    if (typeof fn === 'function' && typeof fn.bind === 'function') {
      fn = fn.bind(client)
    }

    const result = fn(...args)

    if (result && typeof result.then === 'function') {
      return result
    }

    if (result && typeof result.promise === 'function') {
      return result.promise()
    }

    return promisify(fn)(...args)
  }
}
