/* eslint-disable max-len */
'use strict'

const sinon = require('sinon')
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
              TopicArn
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

    describe('no configuration', () => {
      before(() => {
        parentId = '0'
        spanId = '0'

        return agent.load('aws-sdk', { sns: { dsmEnabled: false } }, { dsmEnabled: true })
      })

      before(done => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { sns: { dsmEnabled: false } })

        createResources('TestQueue', 'TestTopic', done)
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
          sns.publish({ TopicArn, Message: 'message 1' }, (e) => {
            if (e) done(e)
          })
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
            topicname: 'TestTopic',
            aws_service: 'SNS',
            region: 'us-east-1'
          })
        }).then(done, done)

        sns.publish({ TopicArn, Message: 'message 1' }, e => e && done(e))
      })
    })

    describe('Data Streams Monitoring', () => {
      const expectedProducerHash = '5117773060236273241'
      const expectedConsumerHash = '1353703578833511841'
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

      it('injects DSM pathway hash to SNS publish span', done => {
        sns.subscribe(subParams, (err, data) => {
          if (err) return done(err)

          sns.publish(
            { TopicArn, Message: 'message DSM' },
            (err) => {
              if (err) return done(err)

              let publishSpanMeta = {}
              agent.use(traces => {
                const span = traces[0][0]

                if (span.resource.startsWith('publish')) {
                  publishSpanMeta = span.meta
                }

                expect(publishSpanMeta).to.include({
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
          expect(statsPointsReceived).to.be.at.least(1)
          expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
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
          expect(statsPointsReceived).to.be.at.least(2)
          expect(agent.dsmStatsExist(agent, expectedConsumerHash)).to.equal(true)
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
            expect(statsPointsReceived).to.be.at.least(3)
            expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
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
