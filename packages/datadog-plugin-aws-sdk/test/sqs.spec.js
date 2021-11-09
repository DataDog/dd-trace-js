'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { setup } = require('./spec_helpers')

const queueOptions = {
  QueueName: 'SQS_QUEUE_NAME',
  Attributes: {
    'MessageRetentionPeriod': '86400'
  }
}

describe('Plugin', () => {
  describe('aws-sdk (sqs)', function () {
    setup()

    withVersions(plugin, 'aws-sdk', version => {
      let AWS
      let sqs
      let QueueUrl
      let tracer

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://localhost:4576')

          sqs = new AWS.SQS({ endpoint, region: 'us-east-1' })
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
          return agent.close()
        })

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

        it('should propagate the tracing context from the producer to the consumer using .promise()', (done) => {
          // No need to test if version does not support .promise();
          if (typeof AWS.Request.prototype.promise !== 'function') {
            done()
            return
          }
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
          }).promise().then(() => {
            return sqs.receiveMessage({
              QueueUrl,
              MessageAttributeNames: ['.*']
            }).promise()
          }).catch(done)
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
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://localhost:4576')

          sqs = new AWS.SQS({ endpoint, region: 'us-east-1' })
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
          return agent.close()
        })

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0

          agent.use(traces => {
            const span = traces[0][0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'sendMessage http://localhost:4576/queue/SQS_QUEUE_NAME'
            })

            total++
          }).catch(() => {}, { timeoutMs: 100 })

          agent.use(traces => {
            const span = traces[0][0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'receiveMessage http://localhost:4576/queue/SQS_QUEUE_NAME'
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
