/* eslint-disable max-len */
'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const { rawExpectedSchema } = require('./sns-naming')

describe('Sns', () => {
  setup()

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let sns
    let sqs
    let subParams
    let receiveParams
    let TopicArn
    let QueueArn
    let QueueUrl
    let parentId
    let spanId
    let tracer

    const snsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sns' : 'aws-sdk'
    const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

    const assertPropagation = done => {
      agent.use(traces => {
        const span = traces[0][0]

        if (span.resource.startsWith('publish')) {
          spanId = span.span_id.toString()
        } else if (span.name === 'aws.response') {
          parentId = span.parent_id.toString()
        }

        expect(parentId).to.not.equal('0')
        expect(parentId).to.equal(spanId)
      }).then(done, done)
    }

    beforeEach(() => {
      tracer = require('../../dd-trace')
    })

    before(() => {
      parentId = '0'
      spanId = '0'

      return agent.load('aws-sdk')
    })

    before(done => {
      const { SNS } = require(`../../../versions/${snsClientName}@${version}`).get()
      const { SQS } = require(`../../../versions/${sqsClientName}@${version}`).get()

      sns = new SNS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
      sqs = new SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

      sns.createTopic({ Name: 'TestTopic' }, (err, data) => {
        if (err) return done(err)

        TopicArn = data.TopicArn

        sqs.createQueue({ QueueName: 'TestQueue' }, (err, data) => {
          if (err) return done(err)

          QueueUrl = data.QueueUrl

          sqs.getQueueAttributes({ QueueUrl, AttributeNames: ['All'] }, (err, data) => {
            if (err) return done(err)

            QueueArn = data.Attributes.QueueArn

            subParams = {
              Protocol: 'sqs',
              Endpoint: QueueArn,
              TopicArn
            }

            receiveParams = {
              QueueUrl,
              MessageAttributeNames: ['.*'],
              WaitTimeSeconds: 1
            }

            done()
          })
        })
      })
    })

    after(done => {
      sns.deleteTopic({ TopicArn }, done)
    })

    after(done => {
      sqs.deleteQueue({ QueueUrl }, done)
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    withPeerService(
      () => tracer,
      'aws-sdk',
      (done) => sns.publish({
        TopicArn,
        Message: 'message 1'
      }, (err) => err && done()),
      'TestTopic', 'topicname')

    withNamingSchema(
      (done) => sns.publish({
        TopicArn,
        Message: 'message 1'
      }, (err) => err && done()),
      rawExpectedSchema.producer,
      {
        desc: 'producer'
      }
    )

    withNamingSchema(
      (done) => sns.getTopicAttributes({
        TopicArn
      }, (err) => err && done(err)),
      rawExpectedSchema.client,
      {
        desc: 'client'
      }
    )

    it('injects trace context to SNS publish', done => {
      assertPropagation(done)

      sns.subscribe(subParams, (err, data) => {
        if (err) return done(err)

        sqs.receiveMessage(receiveParams, e => e && done(e))
        sns.publish({ TopicArn, Message: 'message 1' }, e => e && done(e))
      })
    })

    // There is a bug in 3.x (but not 3.0.0) that will be fixed in 3.261
    // https://github.com/aws/aws-sdk-js-v3/issues/2861
    if (!semver.intersects(version, '<3 || >3.0.0')) {
      it('injects trace context to SNS publishBatch', done => {
        assertPropagation(done)

        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sqs.receiveMessage(receiveParams, e => e && done(e))
          sns.publishBatch({
            TopicArn,
            PublishBatchRequestEntries: [
              { Id: '1', Message: 'message 1' },
              { Id: '2', Message: 'message 2' }
            ]
          }, e => e && done(e))
        })
      })
    }

    // TODO: Figure out why this fails only in 3.0.0
    if (version !== '3.0.0') {
      it('skips injecting trace context to SNS if message attributes are full', done => {
        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sqs.receiveMessage(receiveParams, (err, data) => {
            if (err) return done(err)

            try {
              expect(data.Messages[0].Body).to.not.include('datadog')
              done()
            } catch (e) {
              done(e)
            }
          })

          sns.publish({
            TopicArn,
            Message: 'message 1',
            MessageAttributes: {
              keyOne: { DataType: 'String', StringValue: 'keyOne' },
              keyTwo: { DataType: 'String', StringValue: 'keyTwo' },
              keyThree: { DataType: 'String', StringValue: 'keyThree' },
              keyFour: { DataType: 'String', StringValue: 'keyFour' },
              keyFive: { DataType: 'String', StringValue: 'keyFive' },
              keySix: { DataType: 'String', StringValue: 'keySix' },
              keySeven: { DataType: 'String', StringValue: 'keySeven' },
              keyEight: { DataType: 'String', StringValue: 'keyEight' },
              keyNine: { DataType: 'String', StringValue: 'keyNine' },
              keyTen: { DataType: 'String', StringValue: 'keyTen' }
            }
          }, e => e && done(e))
        })
      })
    }

    it('generates tags for proper publish calls', done => {
      agent.use(traces => {
        const span = traces[0][0]

        expect(span.resource).to.equal(`publish ${TopicArn}`)
        expect(span.meta).to.include({
          'aws.sns.topic_arn': TopicArn,
          'topicname': 'TestTopic',
          'aws_service': 'SNS',
          'region': 'us-east-1'
        })
      }).then(done, done)

      sns.publish({ TopicArn, Message: 'message 1' }, e => e && done(e))
    })
  })
})
