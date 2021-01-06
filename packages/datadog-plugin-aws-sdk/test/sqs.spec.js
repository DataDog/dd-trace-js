'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { setup } = require('./spec_helpers')

wrapIt()

describe('Plugin', () => {
  describe('aws-sdk (sqs)', function () {
    setup()

    withVersions(plugin, 'aws-sdk', version => {
      let AWS
      let sqs
      let tracer

      describe('without configuration', () => {
        let QueueUrl

        before(done => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://localhost:4576')

          sqs = new AWS.SQS({ endpoint, region: 'us-east-1' })
          sqs.createQueue({
            QueueName: 'SQS_QUEUE_NAME',
            Attributes: {
              'MessageRetentionPeriod': '86400'
            }
          }, (err, res) => {
            if (err) return done(err)

            QueueUrl = res.QueueUrl

            agent.load('aws-sdk').then(done, done)
          })
          tracer = require('../../dd-trace')
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl }, err => {
            agent.close().then(() => done(err), done)
          })
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
              MessageAttributeNames: ['All']
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
              MessageAttributeNames: ['All']
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
    })
  })
})
