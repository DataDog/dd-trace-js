'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')
const semver = require('semver')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

describe('Sns', function () {
  setup()
  this.timeout(20000)

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let sns
    let sqs
    let subParams
    let receiveParams
    let TopicArn
    let QueueUrl
    let tracer

    const snsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sns' : 'aws-sdk'
    const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

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

          sqs.getQueueAttributes({
            QueueUrl,
            AttributeNames: ['QueueArn']
          }, (err, data) => {
            if (err) return cb(err)

            const QueueArn = data.Attributes.QueueArn

            subParams = {
              Protocol: 'sqs',
              TopicArn,
              Endpoint: QueueArn
            }

            receiveParams = {
              QueueUrl,
              MessageAttributeNames: ['.*'],
              WaitTimeSeconds: 1
            }

            cb()
          })
        })
      })
    }

    describe('Data Streams Monitoring', () => {
      const expectedProducerHash = '15386798273908484982'
      const expectedConsumerHash = '15162998336469814920'
      let nowStub

      before(() => {
        return agent.load('aws-sdk', { sns: { dsmEnabled: true }, sqs: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      before(done => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { sns: { dsmEnabled: true }, sqs: { dsmEnabled: true } })

        createResources('TestQueueDSM', 'TestTopicDSM', done)
      })

      after(done => {
        sns.deleteTopic({ TopicArn }, done)
      })

      after(done => {
        sqs.deleteQueue({ QueueUrl }, done)
      })

      after(() => {
        return agent.close({ ritmReset: false, wipe: true })
      })

      afterEach(() => {
        try {
          nowStub.restore()
        } catch {
          // pass
        }
        // TODO: Fix this. The third argument is not used.
        agent.reload('aws-sdk', { sns: { dsmEnabled: true, batchPropagationEnabled: true } }, { dsmEnabled: true })
      })

      it('injects DSM pathway hash to SNS publish span', done => {
        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sns.publish(
            { TopicArn, Message: 'message DSM' },
            (err) => {
              if (err) return done(err)

              let publishSpanMeta = {}
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                if (span.resource.startsWith('publish')) {
                  publishSpanMeta = span.meta
                }

                assertObjectContains(publishSpanMeta, {
                  'pathway.hash': expectedProducerHash
                })
              }).then(done, done)
            })
        })
      })

      it('injects DSM pathway hash to SQS receive span from SNS topic', done => {
        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sns.publish(
            { TopicArn, Message: 'message DSM' },
            (err) => {
              if (err) return done(err)
            })

          sqs.receiveMessage(
            receiveParams,
            (err, res) => {
              if (err) return done(err)

              let consumeSpanMeta = {}
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                if (span.name === 'aws.response') {
                  consumeSpanMeta = span.meta
                }

                assertObjectContains(consumeSpanMeta, {
                  'pathway.hash': expectedConsumerHash
                })
              }).then(done, done)
            })
        })
      })

      it('outputs DSM stats to the agent when publishing a message', done => {
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

        sns.subscribe(subParams, () => {
          sns.publish({ TopicArn, Message: 'message DSM' }, () => {})
        })
      })

      it('outputs DSM stats to the agent when consuming a message', done => {
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
        }).then(done, done)

        sns.subscribe(subParams, () => {
          sns.publish({ TopicArn, Message: 'message DSM' }, () => {
            sqs.receiveMessage(receiveParams, () => {})
          })
        })
      })

      it('outputs DSM stats to the agent when publishing batch messages', function (done) {
        // publishBatch was released with version 2.1031.0 for the aws-sdk
        // publishBatch does not work with smithy-client 3.0.0, unable to find compatible version it
        // was released for, but works on 3.374.0
        if (
          (moduleName === '@aws-sdk/smithy-client' && semver.intersects(version, '>=3.374.0')) ||
          (moduleName === 'aws-sdk' && semver.intersects(version, '>=2.1031.0'))
        ) {
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
          }, { timeoutMs: 2000 }).then(done, done)

          sns.subscribe(subParams, () => {
            sns.publishBatch(
              {
                TopicArn,
                PublishBatchRequestEntries: [
                  {
                    Id: '1',
                    Message: 'message DSM 1'
                  },
                  {
                    Id: '2',
                    Message: 'message DSM 2'
                  },
                  {
                    Id: '3',
                    Message: 'message DSM 3'
                  }
                ]
              }, () => {
                nowStub.restore()
              })
          })
        } else {
          this.skip()
        }
      })
    })
  })
})
