'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { callViaPromise, setup, withAwsSdkVersions } = require('./spec_helpers')
const { rawExpectedSchema } = require('./sqs-naming')

const getQueueParams = (queueName) => {
  return {
    QueueName: queueName,
    Attributes: {
      MessageRetentionPeriod: '86400',
    },
  }
}

describe('Plugin', () => {
  describe('aws-sdk (sqs)', function () {
    this.timeout(10000)
    setup()

    withAwsSdkVersions((version, moduleName, resolvedVersion) => {
      let AWS
      let sqs
      let queueName
      let queueOptions
      let QueueUrl
      let tracer

      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'
      // AWS SDK v2 added `.promise()` in 2.3.0; older v2 releases have no promise API to exercise.
      const promisesSupported = moduleName === '@aws-sdk/smithy-client' || semver.gte(resolvedVersion, '2.3.0')

      beforeEach(() => {
        const id = randomUUID()

        queueName = `SQS_QUEUE_NAME-${id}`

        queueOptions = getQueueParams(queueName)

        QueueUrl = `http://127.0.0.1:4566/00000000000000000000/SQS_QUEUE_NAME-${id}`
      })

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')
          tracer.use('aws-sdk', { sqs: { batchPropagationEnabled: true } })

          return agent.load(
            'aws-sdk', { sqs: { dsmEnabled: false, batchPropagationEnabled: true } }, { dsmEnabled: true }
          )
        })

        before(() => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()
          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
        })

        beforeEach(done => {
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

            done()
          })
        })

        afterEach(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        after(() => {
          return agent.close()
        })

        withPeerService(
          () => tracer,
          'aws-sdk',
          (done) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, done),
          () => queueName,
          'queuename'
        )

        withNamingSchema(
          () => new Promise((resolve, reject) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, (err) => err ? reject(err) : resolve())),
          rawExpectedSchema.producer,
          {
            desc: 'producer',
          }
        )

        withNamingSchema(
          () => new Promise((resolve, reject) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, (err) => {
            if (err) return reject(err)

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*'],
            }, (err) => err ? reject(err) : resolve())
          })),
          rawExpectedSchema.consumer,
          {
            desc: 'consumer',
          }
        )

        withNamingSchema(
          () => new Promise((resolve, reject) => {
            sqs.listQueues({}, (err) => err ? reject(err) : resolve())
          }),
          rawExpectedSchema.client,
          {
            desc: 'client',
          }
        )

        it('should propagate the tracing context from the producer to the consumer', (done) => {
          let parentId
          let traceId

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(span.resource.startsWith('sendMessage'), true)
            assertObjectContains(span.meta, {
              queuename: queueName,
              'messaging.system': 'aws_sqs',
              'cloud.resource_id': `arn:aws:sqs:us-east-1:00000000000000000000:${queueName}`,
            })

            parentId = span.span_id.toString()
            traceId = span.trace_id.toString()
          }, { timeoutMs: 10000 })

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(typeof parentId, 'string')
            assert.strictEqual(span.parent_id.toString(), parentId)
            assert.strictEqual(span.trace_id.toString(), traceId)
          }, { timeoutMs: 10000 }).then(done, done)

          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, (err) => {
            if (err) return done(err)

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*'],
            }, (err) => {
              if (err) return done(err)
            })
          })
        })

        if (promisesSupported) {
          it('should propagate the tracing context from the producer to the consumer with promises', async () => {
            let parentId
            let traceId

            const parentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.resource.startsWith('sendMessage'), true)

              parentId = span.span_id.toString()
              traceId = span.trace_id.toString()
            }, { timeoutMs: 10000 })

            const childPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(typeof parentId, 'string')
              assert.strictEqual(span.parent_id.toString(), parentId)
              assert.strictEqual(span.trace_id.toString(), traceId)
            }, { timeoutMs: 10000 })

            await Promise.all([
              parentPromise,
              childPromise,
              (async () => {
                await callViaPromise(sqs, 'sendMessage', { MessageBody: 'test body', QueueUrl })
                await callViaPromise(sqs, 'receiveMessage', { QueueUrl, MessageAttributeNames: ['.*'] })
              })(),
            ])
          })
        }

        it('should propagate the tracing context from the producer to the consumer in batch operations', async () => {
          let parentId
          let traceId

          const sendPromise = new Promise((resolve, reject) => {
            sqs.sendMessageBatch({
              Entries: [
                { Id: '1', MessageBody: 'test batch propagation 1' },
                { Id: '2', MessageBody: 'test batch propagation 2' },
                { Id: '3', MessageBody: 'test batch propagation 3' },
              ],
              QueueUrl,
            }, (err) => err ? reject(err) : resolve())
          })

          const parentPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(span.resource.startsWith('sendMessageBatch'), true)
            assertObjectContains(span.meta, {
              queuename: queueName,
              'messaging.system': 'aws_sqs',
              'cloud.resource_id': `arn:aws:sqs:us-east-1:00000000000000000000:${queueName}`,
            })

            parentId = span.span_id.toString()
            traceId = span.trace_id.toString()
          })

          await Promise.all([sendPromise, parentPromise])

          async function receiveAndAssertMessage () {
            const childPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(typeof parentId, 'string')
              assert.strictEqual(span.parent_id.toString(), parentId)
              assert.strictEqual(span.trace_id.toString(), traceId)
            })

            const receiveMessage = new Promise((resolve, reject) => {
              sqs.receiveMessage({
                QueueUrl,
                MaxNumberOfMessages: 1,
              }, (err, data) => {
                if (err) return reject(err)

                try {
                  for (const message in data.Messages) {
                    const recordData = data.Messages[message].MessageAttributes
                    assert.ok(
                      Object.hasOwn(recordData, '_datadog'),
                      `Available keys: ${inspect(Object.keys(recordData))}`
                    )
                    const traceContext = JSON.parse(recordData._datadog.StringValue)
                    assert.ok(
                      Object.hasOwn(traceContext, 'x-datadog-trace-id'),
                      `Available keys: ${inspect(Object.keys(traceContext))}`
                    )
                  }

                  resolve()
                } catch (e) {
                  reject(e)
                }
              })
            })

            await Promise.all([childPromise, receiveMessage])
          }

          await receiveAndAssertMessage()
          await receiveAndAssertMessage()
          await receiveAndAssertMessage()
        })

        it('should run the consumer in the context of its span', (done) => {
          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, (err) => {
            if (err) return done(err)

            const beforeSpan = tracer.scope().active()

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*'],
            }, (err) => {
              if (err) return done(err)
              const span = tracer.scope().active()

              assert.notStrictEqual(span, beforeSpan)
              assert.strictEqual(span.context().getTag('aws.operation'), 'receiveMessage')

              done()
            })
          })
        })

        it('should run the consumer in the context of its span, for async functions', (done) => {
          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, (err) => {
            if (err) return done(err)

            const beforeSpan = tracer.scope().active()

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*'],
            }, (err) => {
              if (err) return done(err)

              const span = tracer.scope().active()

              assert.notStrictEqual(span, beforeSpan)
              return Promise.resolve().then(() => {
                assert.strictEqual(tracer.scope().active(), span)
                done()
              })
            })
          })
        })

        it('should propagate DSM context from producer to consumer', (done) => {
          sqs.sendMessage({
            MessageBody: 'test DSM',
            QueueUrl,
          }, (err) => {
            if (err) return done(err)

            const beforeSpan = tracer.scope().active()

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*'],
            }, (err) => {
              if (err) return done(err)

              const span = tracer.scope().active()

              assert.notStrictEqual(span, beforeSpan)
              return Promise.resolve().then(() => {
                assert.strictEqual(tracer.scope().active(), span)
                done()
              })
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk', {
            sqs: {
              consumer: false,
              dsmEnabled: false,
            },
          },
          { dsmEnabled: true }
          )
        })

        before(() => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()
          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
        })

        beforeEach(done => {
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

            done()
          })
        })

        afterEach(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        after(() => {
          return agent.close()
        })

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: `sendMessage ${QueueUrl}`,
            })

            assertObjectContains(span.meta, {
              queuename: queueName,
              'messaging.system': 'aws_sqs',
              'cloud.resource_id': `arn:aws:sqs:us-east-1:00000000000000000000:${queueName}`,
              aws_service: 'SQS',
              region: 'us-east-1',
            })
            total++
          }).catch(() => {}, { timeoutMs: 100 })

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: `receiveMessage ${QueueUrl}`,
            })

            total++
          }).catch((e) => {}, { timeoutMs: 100 })

          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl,
          }, () => {})

          sqs.receiveMessage({
            QueueUrl,
            MessageAttributeNames: ['.*'],
          }, () => {})

          setTimeout(() => {
            try {
              assert.strictEqual(total, 1)
              done()
            } catch (e) {
              done(e)
            }
          }, 250)
        })

        it('should not create a consumer span when the consumer is disabled', async () => {
          let consumerSpans = 0
          const callViaCallback = (method, params) => new Promise((resolve, reject) => {
            sqs[method](params, error => error ? reject(error) : resolve())
          })

          await Promise.all([
            // Resolves the moment a consumer span leaks; otherwise it times out (swallowed) with none seen.
            agent.assertSomeTraces(traces => {
              for (const trace of traces) {
                for (const span of trace) {
                  if (span.name === 'aws.response') {
                    consumerSpans++
                    return
                  }
                }
              }
              throw new Error('no consumer span yet')
            }).catch(() => {}),
            (async () => {
              await callViaCallback('sendMessage', { MessageBody: 'callback body', QueueUrl })
              await callViaCallback('receiveMessage', { QueueUrl, MessageAttributeNames: ['.*'] })

              if (promisesSupported) {
                await callViaPromise(sqs, 'sendMessage', { MessageBody: 'promise body', QueueUrl })
                await callViaPromise(sqs, 'receiveMessage', { QueueUrl, MessageAttributeNames: ['.*'] })
              }
            })(),
          ])

          assert.strictEqual(consumerSpans, 0)
        })
      })
    })
  })
})
