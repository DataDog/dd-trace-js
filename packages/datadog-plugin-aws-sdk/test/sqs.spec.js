'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const { rawExpectedSchema } = require('./sqs-naming')

const queueOptions = {
  QueueName: 'SQS_QUEUE_NAME',
  Attributes: {
    'MessageRetentionPeriod': '86400'
  }
}

describe('Plugin', () => {
  describe('aws-sdk (sqs)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let sqs
      let QueueUrl
      let tracer

      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

            QueueUrl = res.QueueUrl

            done()
          })
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        withPeerService(
          () => tracer,
          (done) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => err && done(err)),
          'SQS_QUEUE_NAME',
          'queuename'
        )

        withNamingSchema(
          (done) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => err && done(err)),
          rawExpectedSchema.producer,
          {
            desc: 'producer'
          }
        )

        withNamingSchema(
          (done) => sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => {
            if (err) return done(err)

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*']
            }, (err) => err && done(err))
          }),
          rawExpectedSchema.consumer,
          {
            desc: 'consumer'
          }
        )

        withNamingSchema(
          (done) => sqs.listQueues({}, (err) => err && done(err)),
          rawExpectedSchema.client,
          {
            desc: 'client'
          }
        )

        it('should propagate the tracing context from the producer to the consumer', (done) => {
          let parentId
          let traceId

          agent.use(traces => {
            const span = traces[0][0]

            expect(span.resource.startsWith('sendMessage')).to.equal(true)

            parentId = span.span_id.toString()
            traceId = span.trace_id.toString()
          })

          agent.use(traces => {
            const span = traces[0][0]

            expect(parentId).to.be.a('string')
            expect(span.parent_id.toString()).to.equal(parentId)
            expect(span.trace_id.toString()).to.equal(traceId)
          }).then(done, done)

          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => {
            if (err) return done(err)

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*']
            }, (err) => {
              if (err) return done(err)
            })
          })
        })

        it('should run the consumer in the context of its span', (done) => {
          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => {
            if (err) return done(err)

            const beforeSpan = tracer.scope().active()

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*']
            }, (err) => {
              if (err) return done(err)
              const span = tracer.scope().active()

              expect(span).to.not.equal(beforeSpan)
              expect(span.context()._tags['aws.operation']).to.equal('receiveMessage')

              done()
            })
          })
        })

        it('should run the consumer in the context of its span, for async functions', (done) => {
          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, (err) => {
            if (err) return done(err)

            const beforeSpan = tracer.scope().active()

            sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*']
            }, (err) => {
              if (err) return done(err)

              const span = tracer.scope().active()

              expect(span).to.not.equal(beforeSpan)
              return Promise.resolve().then(() => {
                expect(tracer.scope().active()).to.equal(span)
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
              consumer: false
            }
          })
        })

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

            QueueUrl = res.QueueUrl

            done()
          })
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0

          agent.use(traces => {
            const span = traces[0][0]

            expect(span).to.include({
              name: 'aws.request',
              resource: `sendMessage ${QueueUrl}`
            })

            expect(span.meta).to.include({
              'queuename': 'SQS_QUEUE_NAME',
              'aws_service': 'SQS',
              'region': 'us-east-1'
            })
            total++
          }).catch(() => {}, { timeoutMs: 100 })

          agent.use(traces => {
            const span = traces[0][0]

            expect(span).to.include({
              name: 'aws.request',
              resource: `receiveMessage ${QueueUrl}`
            })

            total++
          }).catch((e) => {}, { timeoutMs: 100 })

          sqs.sendMessage({
            MessageBody: 'test body',
            QueueUrl
          }, () => {})

          sqs.receiveMessage({
            QueueUrl,
            MessageAttributeNames: ['.*']
          }, () => {})

          setTimeout(() => {
            try {
              expect(total).to.equal(1)
              done()
            } catch (e) {
              done(e)
            }
          }, 250)
        })
      })
    })
  })
})
