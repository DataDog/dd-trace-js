'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { setup } = require('./spec_helpers')

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

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let sqs
      let queueNameDSM
      let queueNameDSMConsumerOnly
      let queueOptionsDsm
      let queueOptionsDsmConsumerOnly
      let QueueUrlDsm
      let QueueUrlDsmConsumerOnly
      let tracer

      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

      beforeEach(() => {
        const id = randomUUID()
        queueNameDSM = `SQS_QUEUE_NAME_DSM-${id}`
        queueNameDSMConsumerOnly = `SQS_QUEUE_NAME_DSM_CONSUMER_ONLY-${id}`
        queueOptionsDsm = getQueueParams(queueNameDSM)
        queueOptionsDsmConsumerOnly = getQueueParams(queueNameDSMConsumerOnly)
        QueueUrlDsm = `http://127.0.0.1:4566/00000000000000000000/${queueNameDSM}`
        QueueUrlDsmConsumerOnly = `http://127.0.0.1:4566/00000000000000000000/${queueNameDSMConsumerOnly}`
      })

      describe('data stream monitoring', () => {
        let expectedProducerHash
        let expectedConsumerHash
        let nowStub

        before(() => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = require('../../dd-trace')
          tracer.use('aws-sdk', { sqs: { dsmEnabled: true } })
        })

        before(async () => {
          return agent.load('aws-sdk', {
            sqs: {
              dsmEnabled: true,
            },
          },
          { dsmEnabled: true })
        })

        before(() => {
          AWS = require(`../../../versions/${sqsClientName}@${version}`).get()
          sqs = new AWS.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
        })

        beforeEach(() => {
          const producerHash = computePathwayHash(
            'test',
            'tester',
            ['direction:out', 'topic:' + queueNameDSM, 'type:sqs'],
            ENTRY_PARENT_HASH
          )

          expectedProducerHash = producerHash.readBigUInt64LE(0).toString()
          expectedConsumerHash = computePathwayHash(
            'test',
            'tester',
            ['direction:in', 'topic:' + queueNameDSM, 'type:sqs'],
            producerHash
          ).readBigUInt64LE(0).toString()
        })

        beforeEach(done => {
          sqs.createQueue(queueOptionsDsm, (err, res) => err ? done(err) : done())
        })

        beforeEach(done => {
          sqs.createQueue(queueOptionsDsmConsumerOnly, (err, res) => err ? done(err) : done())
        })

        afterEach(done => {
          sqs.deleteQueue({ QueueUrl: QueueUrlDsm }, done)
        })

        afterEach(done => {
          sqs.deleteQueue({ QueueUrl: QueueUrlDsmConsumerOnly }, done)
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
            QueueUrl: QueueUrlDsm,
          }, (err) => {
            if (err) return done(err)

            let produceSpanMeta = {}
            agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              if (span.resource.startsWith('sendMessage')) {
                produceSpanMeta = span.meta
              }

              assertObjectContains(produceSpanMeta, {
                'pathway.hash': expectedProducerHash,
              })
            }).then(done, done)
          })
        })

        it('Should set pathway hash tag on a span when consuming', (done) => {
          sqs.sendMessage({
            MessageBody: 'test DSM',
            QueueUrl: QueueUrlDsm,
          }, (err) => {
            if (err) return done(err)

            sqs.receiveMessage({
              QueueUrl: QueueUrlDsm,
              MessageAttributeNames: ['.*'],
            }, (err) => {
              if (err) return done(err)

              let consumeSpanMeta = {}
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                if (span.name === 'aws.response') {
                  consumeSpanMeta = span.meta
                }

                assertObjectContains(consumeSpanMeta, {
                  'pathway.hash': expectedConsumerHash,
                })
              }).then(done, done)
            })
          })
        })

        if (sqsClientName === 'aws-sdk' && semver.intersects(version, '>=2.3')) {
          it('Should set pathway hash tag on a span when consuming and promise() was used over a callback',
            async () => {
              let consumeSpanMeta = {}
              const tracePromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                if (span.name === 'aws.request' && span.meta['aws.operation'] === 'receiveMessage') {
                  consumeSpanMeta = span.meta
                }

                assertObjectContains(consumeSpanMeta, {
                  'pathway.hash': expectedConsumerHash,
                })
              })

              await sqs.sendMessage({ MessageBody: 'test DSM', QueueUrl: QueueUrlDsm }).promise()
              await sqs.receiveMessage({ QueueUrl: QueueUrlDsm }).promise()

              return tracePromise
            })
        }

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
            assert.ok(statsPointsReceived >= 1)
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
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
            assert.ok(statsPointsReceived >= 2)
            assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
          }, { timeoutMs: 5000 }).then(done, done)

          sqs.sendMessage({ MessageBody: 'test DSM', QueueUrl: QueueUrlDsm }, () => {
            sqs.receiveMessage({ QueueUrl: QueueUrlDsm, MessageAttributeNames: ['.*'] }, () => {})
          })
        })

        it('Should emit DSM stats when receiving a message when the producer was not instrumented', done => {
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
            assert.strictEqual(statsPointsReceived, 1)
            assert.strictEqual(agent.dsmStatsExistWithParentHash(agent, '0'), true)
          }).then(done, done)

          agent.reload('aws-sdk', { sqs: { dsmEnabled: false } }, { dsmEnabled: false })
          sqs.sendMessage({ MessageBody: 'test DSM', QueueUrl: QueueUrlDsmConsumerOnly }, () => {
            agent.reload('aws-sdk', { sqs: { dsmEnabled: true } }, { dsmEnabled: true })
            sqs.receiveMessage({ QueueUrl: QueueUrlDsmConsumerOnly, MessageAttributeNames: ['.*'] }, () => {})
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
            assert.ok(statsPointsReceived >= 3)
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
          }).then(done, done)

          sqs.sendMessageBatch(
            {
              Entries: [
                {
                  Id: '1',
                  MessageBody: 'test DSM 1',
                },
                {
                  Id: '2',
                  MessageBody: 'test DSM 2',
                },
                {
                  Id: '3',
                  MessageBody: 'test DSM 3',
                },
              ],
              QueueUrl: QueueUrlDsm,
            }, () => {
              nowStub.restore()
            })
        })

        describe('syncToStore', () => {
          let syncToStoreSpy

          beforeEach(() => {
            syncToStoreSpy = sinon.spy(DataStreamsContext, 'syncToStore')
          })

          afterEach(() => {
            syncToStoreSpy.restore()
          })

          it('Should call syncToStore after sending a message', done => {
            sqs.sendMessage({
              MessageBody: 'syncToStore test',
              QueueUrl: QueueUrlDsm,
            }, (err) => {
              if (err) return done(err)
              assert.ok(syncToStoreSpy.called, 'syncToStore should be called on send')
              done()
            })
          })

          it('Should call syncToStore after receiving a message', done => {
            sqs.sendMessage({
              MessageBody: 'syncToStore test',
              QueueUrl: QueueUrlDsm,
            }, (err) => {
              if (err) return done(err)

              sqs.receiveMessage({
                QueueUrl: QueueUrlDsm,
                MessageAttributeNames: ['.*'],
              }, (err) => {
                if (err) return done(err)
                assert.ok(syncToStoreSpy.called, 'syncToStore should be called on receive')
                done()
              })
            })
          })
        })
      })
    })
  })
})
