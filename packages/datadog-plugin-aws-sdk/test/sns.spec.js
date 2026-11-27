'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, before, describe, it } = require('mocha')
const semver = require('semver')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { withNamingSchema, withPeerService } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { callViaCallback, setup, withAwsSdkVersions } = require('./spec_helpers')
const { rawExpectedSchema } = require('./sns-naming')

describe('Sns', function () {
  setup()
  this.timeout(20000)

  withAwsSdkVersions('@aws-sdk/client-sns', (version, moduleName, resolvedVersion) => {
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

    const snsClientName = moduleName !== 'aws-sdk' ? '@aws-sdk/client-sns' : 'aws-sdk'
    const sqsClientName = moduleName !== 'aws-sdk' ? '@aws-sdk/client-sqs' : 'aws-sdk'

    const assertPropagation = done => {
      agent.assertSomeTraces(traces => {
        const span = traces[0][0]

        if (span.resource.startsWith('publish')) {
          spanId = span.span_id.toString()
        } else if (span.name === 'aws.response') {
          parentId = span.parent_id.toString()
        }

        assert.notStrictEqual(parentId, '0')
        assert.strictEqual(parentId, spanId)
      }, { timeoutMs: 20000 }).then(done, done)
    }

    function createResources (queueName, topicName, cb) {
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

            QueueArn = data.Attributes.QueueArn

            subParams = {
              Protocol: 'sqs',
              Endpoint: QueueArn,
              TopicArn,
            }

            receiveParams = {
              QueueUrl,
              MessageAttributeNames: ['.*'],
              WaitTimeSeconds: 1,
            }

            cb()
          })
        })
      })
    }

    describe('with payload tagging', () => {
      before(async () => {
        await agent.load('aws-sdk')
        await agent.close()
        await agent.load('aws-sdk', {}, {
          cloudPayloadTagging: {
            request: '$.MessageAttributes.foo,$.MessageAttributes.redacted.StringValue.foo',
            response: '$.MessageId,$.Attributes.DisplayName',
            maxDepth: 5,
          },
        })
      })

      after(() => agent.close())

      before(done => {
        createResources('TestQueue', 'TestTopic', done)
      })

      after(done => {
        sns.deleteTopic({ TopicArn }, done)
      })

      after(done => {
        sqs.deleteQueue({ QueueUrl }, done)
      })

      it('adds request and response payloads as flattened tags', done => {
        agent.assertFirstTraceSpan({
          resource: `publish ${TopicArn}`,
          meta: {
            'aws.sns.topic_arn': TopicArn,
            'messaging.system': 'aws.sns',
            topicname: 'TestTopic',
            aws_service: 'SNS',
            region: 'us-east-1',
            'aws.request.body.TopicArn': TopicArn,
            'aws.request.body.Message': 'message 1',
            'aws.request.body.MessageAttributes.baz.DataType': 'String',
            'aws.request.body.MessageAttributes.baz.StringValue': 'bar',
            'aws.request.body.MessageAttributes.keyOne.DataType': 'String',
            'aws.request.body.MessageAttributes.keyOne.StringValue': 'keyOne',
            'aws.request.body.MessageAttributes.keyTwo.DataType': 'String',
            'aws.request.body.MessageAttributes.keyTwo.StringValue': 'keyTwo',
            'aws.response.body.MessageId': 'redacted',
          },
        }, { timeoutMs: 20000 }).then(done, done)

        sns.publish({
          TopicArn,
          Message: 'message 1',
          MessageAttributes: {
            baz: { DataType: 'String', StringValue: 'bar' },
            keyOne: { DataType: 'String', StringValue: 'keyOne' },
            keyTwo: { DataType: 'String', StringValue: 'keyTwo' },
          },
        }, e => e && done(e))
      })

      it('expands and redacts keys identified as expandable', done => {
        agent.assertFirstTraceSpan({
          resource: `publish ${TopicArn}`,
          meta: {
            'aws.sns.topic_arn': TopicArn,
            'messaging.system': 'aws.sns',
            topicname: 'TestTopic',
            aws_service: 'SNS',
            region: 'us-east-1',
            'aws.request.body.TopicArn': TopicArn,
            'aws.request.body.Message': 'message 1',
            'aws.request.body.MessageAttributes.redacted.StringValue.foo': 'redacted',
            'aws.request.body.MessageAttributes.unredacted.StringValue.foo': 'bar',
            'aws.request.body.MessageAttributes.unredacted.StringValue.baz': 'yup',
            'aws.response.body.MessageId': 'redacted',
          },
        }, { timeoutMs: 20000 }).then(done, done)

        sns.publish({
          TopicArn,
          Message: 'message 1',
          MessageAttributes: {
            unredacted: { DataType: 'String', StringValue: '{"foo": "bar", "baz": "yup"}' },
            redacted: { DataType: 'String', StringValue: '{"foo": "bar"}' },
          },
        }, e => e && done(e))
      })

      describe('user-defined redaction', () => {
        it('redacts user-defined keys to suppress in request', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assertObjectContains(span, {
              resource: `publish ${TopicArn}`,
              meta: {
                'aws.sns.topic_arn': TopicArn,
                'messaging.system': 'aws.sns',
                topicname: 'TestTopic',
                aws_service: 'SNS',
                region: 'us-east-1',
                'aws.request.body.TopicArn': TopicArn,
                'aws.request.body.Message': 'message 1',
                'aws.request.body.MessageAttributes.foo': 'redacted',
                'aws.request.body.MessageAttributes.keyOne.DataType': 'String',
                'aws.request.body.MessageAttributes.keyOne.StringValue': 'keyOne',
                'aws.request.body.MessageAttributes.keyTwo.DataType': 'String',
                'aws.request.body.MessageAttributes.keyTwo.StringValue': 'keyTwo',
              },
            })

            assert.ok(
              Object.hasOwn(span.meta, 'aws.response.body.MessageId'),
              `Available keys: ${inspect(Object.keys(span.meta))}`
            )
          }, { timeoutMs: 20000 }).then(done, done)

          sns.publish({
            TopicArn,
            Message: 'message 1',
            MessageAttributes: {
              foo: { DataType: 'String', StringValue: 'bar' },
              keyOne: { DataType: 'String', StringValue: 'keyOne' },
              keyTwo: { DataType: 'String', StringValue: 'keyTwo' },
            },
          }, e => e && done(e))
        })

        // TODO add response tests
        it('redacts user-defined keys to suppress in response', done => {
          agent.assertFirstTraceSpan({
            resource: `getTopicAttributes ${TopicArn}`,
            meta: {
              'aws.sns.topic_arn': TopicArn,
              'messaging.system': 'aws.sns',
              topicname: 'TestTopic',
              aws_service: 'SNS',
              region: 'us-east-1',
              'aws.request.body.TopicArn': TopicArn,
              'aws.response.body.Attributes.DisplayName': 'redacted',
            },
          }, { timeoutMs: 20000 }).then(done, done)

          sns.getTopicAttributes({ TopicArn }, e => e && done(e))
        })
      })

      describe('redaction of internally suppressed keys', () => {
        const supportsSMSNotification = (moduleName, version) => {
          switch (moduleName) {
            case 'aws-sdk':
              // aws-sdk-js phone notifications introduced in c6d1bb1a
              return semver.intersects(version, '>=2.10.0')
            case '@aws-sdk/client-sns':
              return true
            default:
              return false
          }
        }

        if (supportsSMSNotification(moduleName, version)) {
          // TODO
          describe.skip('phone number', () => {
            before(done => {
              sns.createSMSSandboxPhoneNumber({ PhoneNumber: '+33628606135' }, err => err && done(err))
              sns.createSMSSandboxPhoneNumber({ PhoneNumber: '+33628606136' }, err => err && done(err))
            })

            after(done => {
              sns.deleteSMSSandboxPhoneNumber({ PhoneNumber: '+33628606135' }, err => err && done(err))
              sns.deleteSMSSandboxPhoneNumber({ PhoneNumber: '+33628606136' }, err => err && done(err))
            })

            it('redacts phone numbers in request', done => {
              agent.assertFirstTraceSpan({
                resource: 'publish',
                meta: {
                  aws_service: 'SNS',
                  region: 'us-east-1',
                  'aws.request.body.PhoneNumber': 'redacted',
                  'aws.request.body.Message': 'message 1',
                },
              }, { timeoutMs: 20000 }).then(done, done)

              sns.publish({
                PhoneNumber: '+33628606135',
                Message: 'message 1',
              }, e => e && done(e))
            })

            it('redacts phone numbers in response', done => {
              agent.assertFirstTraceSpan({
                resource: 'publish',
                meta: {
                  aws_service: 'SNS',
                  region: 'us-east-1',
                  'aws.response.body.PhoneNumber': 'redacted',
                },
              }, { timeoutMs: 20000 }).then(done, done)

              sns.listSMSSandboxPhoneNumbers({
                PhoneNumber: '+33628606135',
                Message: 'message 1',
              }, e => e && done(e))
            })
          })
        }

        describe('subscription confirmation tokens', () => {
          it('redacts tokens in request', done => {
            agent.assertFirstTraceSpan({
              resource: `confirmSubscription ${TopicArn}`,
              meta: {
                aws_service: 'SNS',
                'aws.sns.topic_arn': TopicArn,
                'messaging.system': 'aws.sns',
                topicname: 'TestTopic',
                region: 'us-east-1',
                'aws.request.body.Token': 'redacted',
                'aws.request.body.TopicArn': TopicArn,
              },
            }).then(done, done)

            sns.confirmSubscription({
              TopicArn,
              Token: '1234',
            }, () => {})
          })

          // TODO
          it.skip('redacts tokens in response', () => {

          })
        })
      })
    })

    const describePublishBatch = moduleName !== 'aws-sdk' && semver.gte(resolvedVersion, '3.374.0')
      ? describe
      : describe.skip

    describePublishBatch('publishBatch', () => {
      before(async () => {
        await agent.load('aws-sdk', { sns: { dsmEnabled: false, batchPropagationEnabled: true } }, { dsmEnabled: true })
      })

      before(done => {
        createResources('TestPublishBatchQueue', 'TestPublishBatchTopic', done)
      })

      before(() => callViaCallback(sns, 'subscribe', subParams))

      after(async () => {
        try {
          await Promise.all([
            callViaCallback(sns, 'deleteTopic', { TopicArn }),
            callViaCallback(sqs, 'deleteQueue', { QueueUrl }),
          ])
        } finally {
          await agent.close()
        }
      })

      /** @param {number} batchSize */
      function assertBatchPropagation (batchSize) {
        const consumers = new Map()
        let producer

        return agent.assertSomeTraces(traces => {
          for (const span of traces.flat()) {
            if (span.resource === `publishBatch ${TopicArn}`) {
              producer = span
            } else if (span.name === 'aws.response') {
              consumers.set(span.span_id.toString(), span)
            }
          }

          assert.ok(producer)
          const parentId = producer.span_id.toString()
          const linked = [...consumers.values()].filter(span => span.parent_id.toString() === parentId)
          assert.strictEqual(linked.length, batchSize)
        }, {
          timeoutMs: 20000,
          async operation () {
            const entries = Array.from({ length: batchSize }, (_, index) => ({
              Id: String(index),
              Message: `batch message ${index}`,
            }))
            await callViaCallback(sns, 'publishBatch', { TopicArn, PublishBatchRequestEntries: entries })

            const received = new Set()
            // The tracer creates one consumer span for each receive operation.
            for (let index = 0; index < batchSize; index++) {
              const { Messages } = await callViaCallback(sqs, 'receiveMessage', receiveParams)
              assert.strictEqual(Messages?.length, 1)
              const notification = JSON.parse(Messages[0].Body)
              const carrier = notification.MessageAttributes?._datadog
              assert.ok(carrier)
              const attributes = JSON.parse(Buffer.from(carrier.Value, 'base64'))
              assert.ok(Object.hasOwn(attributes, 'x-datadog-trace-id'))
              received.add(notification.Message)
              await callViaCallback(sqs, 'deleteMessage', { QueueUrl, ReceiptHandle: Messages[0].ReceiptHandle })
            }
            assert.deepStrictEqual(received, new Set(entries.map(entry => entry.Message)))
          },
        })
      }

      it('injects trace context to SNS publishBatch', () => assertBatchPropagation(2))

      it('injects trace context to each message SNS publishBatch with batch propagation enabled', () => {
        return assertBatchPropagation(3)
      })
    })

    describe('no configuration', () => {
      before(() => {
        parentId = '0'
        spanId = '0'

        return agent.load(
          'aws-sdk',
          { sns: { dsmEnabled: false, batchPropagationEnabled: true } }, { dsmEnabled: true }
        )
      })

      before(done => {
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { sns: { dsmEnabled: false, batchPropagationEnabled: true } })

        createResources('TestQueue', 'TestTopic', done)
      })

      after(done => {
        sns.deleteTopic({ TopicArn }, done)
      })

      after(done => {
        sqs.deleteQueue({ QueueUrl }, done)
      })

      after(() => {
        return agent.close()
      })

      withPeerService(
        () => tracer,
        'aws-sdk',
        (done) => sns.publish({
          TopicArn,
          Message: 'message 1',
        }, done),
        'TestTopic', 'topicname')

      withNamingSchema(
        (done) => sns.publish({
          TopicArn,
          Message: 'message 1',
        }, (err) => err && done()),
        rawExpectedSchema.producer,
        {
          desc: 'producer',
        }
      )

      withNamingSchema(
        (done) => sns.getTopicAttributes({
          TopicArn,
        }, (err) => err && done(err)),
        rawExpectedSchema.client,
        {
          desc: 'client',
        }
      )

      it('injects trace context to SNS publish', done => {
        assertPropagation(done)

        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sqs.receiveMessage(receiveParams, e => e && done(e))
          sns.publish({ TopicArn, Message: 'message 1' }, (e) => {
            if (e) done(e)
          })
        })
      })

      // TODO: Figure out why this fails only in 3.0.0
      if (version !== '3.0.0') {
        it('skips injecting trace context to SNS if message attributes are full', done => {
          sns.subscribe(subParams, (err, data) => {
            if (err) return done(err)

            sqs.receiveMessage(receiveParams, (err, data) => {
              if (err) return done(err)

              try {
                assert.doesNotMatch(data.Messages[0].Body, /datadog/)
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
                keyTen: { DataType: 'String', StringValue: 'keyTen' },
              },
            }, e => e && done(e))
          })
        })
      }

      it('generates tags for proper publish calls', done => {
        agent.assertFirstTraceSpan({
          resource: `publish ${TopicArn}`,
          meta: {
            'aws.sns.topic_arn': TopicArn,
            'messaging.system': 'aws.sns',
            topicname: 'TestTopic',
            aws_service: 'SNS',
            region: 'us-east-1',
          },
        }).then(done, done)

        sns.publish({ TopicArn, Message: 'message 1' }, e => e && done(e))
      })
    })
  })
})
