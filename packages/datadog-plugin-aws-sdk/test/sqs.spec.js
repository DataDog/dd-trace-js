'use strict'

const sinon = require('sinon')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const { rawExpectedSchema } = require('./sqs-naming')

const queueName = 'SQS_QUEUE_NAME'
const queueNameDSM = 'SQS_QUEUE_NAME_DSM'

const getQueueParams = (queueName) => {
  return {
    QueueName: queueName,
    Attributes: {
      MessageRetentionPeriod: '86400'
    }
  }
}

const queueOptions = getQueueParams(queueName)
const queueOptionsDsm = getQueueParams(queueNameDSM)

describe('Plugin', () => {
  describe('aws-sdk (sqs)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let sqs
      const QueueUrl = 'http://127.0.0.1:4566/00000000000000000000/SQS_QUEUE_NAME'
      const QueueUrlDsm = 'http://127.0.0.1:4566/00000000000000000000/SQS_QUEUE_NAME_DSM'
      let tracer

      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

      describe('without configuration', () => {
        before(() => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk', { sqs: { dsmEnabled: false } }, { dsmEnabled: true })
        })

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

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
          'aws-sdk',
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
            expect(span.meta).to.include({
              queuename: 'SQS_QUEUE_NAME'
            })

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

        it('should propagate DSM context from producer to consumer', (done) => {
          sqs.sendMessage({
            MessageBody: 'test DSM',
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
              consumer: false,
              dsmEnabled: false
            }
          },
          { dsmEnabled: true }
          )
        })

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptions, (err, res) => {
            if (err) return done(err)

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
              queuename: 'SQS_QUEUE_NAME',
              aws_service: 'SQS',
              region: 'us-east-1'
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

      describe('data stream monitoring', () => {
        const expectedProducerHash = '17841701523812548799'
        const expectedConsumerHash = '3208696069325693319'
        let nowStub

        before(() => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = require('../../dd-trace')
          tracer.use('aws-sdk', { sqs: { dsmEnabled: true } })
        })

        before(async () => {
          return agent.load('aws-sdk', {
            sqs: {
              consumer: false,
              dsmEnabled: true
            }
          },
          { dsmEnabled: true })
        })

        before(done => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()

          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          sqs.createQueue(queueOptionsDsm, (err, res) => {
            if (err) return done(err)

            done()
          })
        })

        after(done => {
          sqs.deleteQueue({ QueueUrl: QueueUrlDsm }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        afterEach(() => {
          try {
            nowStub.restore()
          } catch {
            // pass
          }
          agent.reload('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
        })

        it('Should set pathway hash tag on a span when producing', (done) => {
          sqs.sendMessage({
            MessageBody: 'test DSM',
            QueueUrl: QueueUrlDsm
          }, (err) => {
            if (err) return done(err)

            let produceSpanMeta = {}
            agent.use(traces => {
              const span = traces[0][0]

              if (span.resource.startsWith('sendMessage')) {
                produceSpanMeta = span.meta
              }

              expect(produceSpanMeta).to.include({
                'pathway.hash': expectedProducerHash
              })
            }).then(done, done)
          })
        })

        it('Should set pathway hash tag on a span when consuming', (done) => {
          sqs.sendMessage({
            MessageBody: 'test DSM',
            QueueUrl: QueueUrlDsm
          }, (err) => {
            if (err) return done(err)

            sqs.receiveMessage({
              QueueUrl: QueueUrlDsm,
              MessageAttributeNames: ['.*']
            }, (err) => {
              if (err) return done(err)

              let consumeSpanMeta = {}
              agent.use(traces => {
                const span = traces[0][0]

                if (span.name === 'aws.response') {
                  consumeSpanMeta = span.meta
                }

                expect(consumeSpanMeta).to.include({
                  'pathway.hash': expectedConsumerHash
                })
              }).then(done, done)
            })
          })
        })

        it('Should emit DSM stats to the agent when sending a message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = 0
            // we should have 1 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived += statsBuckets.Stats.length
                })
              }
            })
            expect(statsPointsReceived).to.be.at.least(1)
            expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
          }).then(done, done)

          sqs.sendMessage({ MessageBody: 'test DSM', QueueUrl: QueueUrlDsm }, () => {})
        })

        it('Should emit DSM stats to the agent when receiving a message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = 0
            // we should have 2 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived += statsBuckets.Stats.length
                })
              }
            })
            expect(statsPointsReceived).to.be.at.least(2)
            expect(agent.dsmStatsExist(agent, expectedConsumerHash)).to.equal(true)
          }).then(done, done)

          sqs.sendMessage({ MessageBody: 'test DSM', QueueUrl: QueueUrlDsm }, () => {
            sqs.receiveMessage({ QueueUrl: QueueUrlDsm, MessageAttributeNames: ['.*'] }, () => {})
          })
        })

        it('Should emit DSM stats to the agent when sending batch messages', done => {
          // we need to stub Date.now() to ensure a new stats bucket is created for each call
          // otherwise, all stats checkpoints will be combined into a single stats points
          let now = Date.now()
          nowStub = sinon.stub(Date, 'now')
          nowStub.callsFake(() => {
            now += 1000000
            return now
          })

          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = 0
            // we should have 3 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived += statsBuckets.Stats.length
                })
              }
            })
            expect(statsPointsReceived).to.be.at.least(3)
            expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
          }).then(done, done)

          sqs.sendMessageBatch(
            {
              Entries: [
                {
                  Id: '1',
                  MessageBody: 'test DSM 1'
                },
                {
                  Id: '2',
                  MessageBody: 'test DSM 2'
                },
                {
                  Id: '3',
                  MessageBody: 'test DSM 3'
                }
              ],
              QueueUrl: QueueUrlDsm
            }, () => {
              nowStub.restore()
            })
        })
      })
    })
  })
})
