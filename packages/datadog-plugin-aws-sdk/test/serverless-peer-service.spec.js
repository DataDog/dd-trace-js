'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const Config = require('../../dd-trace/src/config')
const helpers = require('./kinesis_helpers')
const { promisify } = require('util')
const { setup } = require('./spec_helpers')
const sinon = require('sinon')

describe('Plugin', () => {
  describe('Serverless', function () {
    let tracer
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS

      before(async () => {
        tracer = require('../../dd-trace')
        sinon.stub(Config.prototype, '_isInServerlessEnvironment').returns(true)
        // force a reload of the plugins by deleting the plugin instance
        delete tracer._pluginManager._pluginsByName['aws-sdk']
        // load the agent and plugins again to ensure `_isInServerlessEnvironment` check
        // in the plugin constructor is called and the necessary channels are subscribed
        await agent.load(['aws-sdk', 'http'], [{}, { server: false }])
      })

      after(async () => {
        Config.prototype._isInServerlessEnvironment.restore()
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

          const tracesPromise = agent.assertSomeTraces(assertPeerServicePropagation)

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

        it('propagates peer.service', done => {
          agent.assertSomeTraces(assertPeerServicePropagation, { timeoutMs: 10000 })
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
          agent.assertSomeTraces(assertPeerServicePropagation)
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
          agent.assertSomeTraces(assertPeerServicePropagation)
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

        after(async () => {
          return agent.close({ ritmReset: false })
        })

        it('propagates peer.service from aws span to underlying http span', done => {
          agent.assertSomeTraces(assertPeerServicePropagation)
            .then(done, done)

          s3.copyObject({
            Bucket: bucketName,
            Key: 'new-key',
            CopySource: `${bucketName}/test-key`
          }, (err) => {
            if (err) {
              done(err)
            }
          })
        })
      })
    })
  })
})

function assertPeerServicePropagation (traces) {
  const spans = traces[0]
  const awsSpan = spans.find(s => s.name === 'aws.request')
  const httpSpan = spans.find(s => s.name === 'http.request')

  expect(awsSpan, 'expected the aws span to exist').to.exist
  expect(httpSpan, 'expected the underlying http span to exist').to.exist

  expect(awsSpan.meta['peer.service'],
    'expected the aws span to have a peer.service tag'
  ).to.exist

  expect(httpSpan.meta['peer.service'],
    'expected the underlying http span to have a peer.service tag'
  ).to.exist

  expect(awsSpan.meta['peer.service'],
    'expected the aws span peer.service tag not to have region "undefined"'
  ).to.not.include('undefined')

  expect(httpSpan.meta['peer.service'],
    'expected the underlying http span peer.service tag not to have region "undefined"'
  ).to.not.include('undefined')

  expect(awsSpan.meta['peer.service'],
    'expected the aws span to have the same peer.service tag as the underlying http span'
  ).to.equal(httpSpan.meta['peer.service'])
}
