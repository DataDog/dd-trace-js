/* eslint-disable @stylistic/max-len */
'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const helpers = require('./kinesis_helpers')
const { rawExpectedSchema } = require('./kinesis-naming')
const id = require('../../dd-trace/src/id')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const agentTimeout = 20000

describe('Kinesis', function () {
  this.timeout(20000)
  setup()

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let AWS
    let kinesis
    let tracer

    const kinesisClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-kinesis' : 'aws-sdk'

    function createResources (streamName, cb) {
      AWS = require(`../../../versions/${kinesisClientName}@${version}`).get()

      const params = {
        endpoint: 'http://127.0.0.1:4566',
        region: 'us-east-1'
      }

      if (moduleName === '@aws-sdk/smithy-client') {
        const { NodeHttpHandler } = require(`../../../versions/@aws-sdk/node-http-handler@${version}`).get()

        params.requestHandler = new NodeHttpHandler()
      }

      kinesis = new AWS.Kinesis(params)

      kinesis.createStream({
        StreamName: streamName,
        ShardCount: 1
      }, (err, res) => {
        if (err) return cb(err)

        helpers.waitForActiveStream(kinesis, streamName, cb)
      })
    }

    before(() => {
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
    })

    describe('no configuration', () => {
      let streamName

      beforeEach(() => {
        return agent.load('aws-sdk', { kinesis: { dsmEnabled: false, batchPropagationEnabled: true } }, { dsmEnabled: true })
      })

      beforeEach(done => {
        streamName = `MyStream-${id()}`
        createResources(streamName, done)
      })

      afterEach(done => {
        kinesis.deleteStream({
          StreamName: streamName
        }, (err, res) => {
          if (err) return done(err)

          helpers.waitForDeletedStream(kinesis, streamName, done)
        })
      })

      withNamingSchema(
        (done) => kinesis.describeStream({
          StreamName: streamName
        }, (err) => err && done(err)),
        rawExpectedSchema.outbound
      )

      it('injects trace context to Kinesis putRecord', done => {
        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamName, data, (err, data) => {
            if (err) return done(err)

            expect(data).to.have.property('_datadog')
            expect(data._datadog).to.have.property('x-datadog-trace-id')

            done()
          })
        })
      })

      it('injects trace context to each message during Kinesis putRecord and batchPropagationEnabled', done => {
        helpers.putTestRecords(kinesis, streamName, (err, data) => {
          if (err) return done(err)

          helpers.getTestRecord(kinesis, streamName, data.Records[0], (err, data) => {
            if (err) return done(err)

            for (const record in data.Records) {
              const recordData = JSON.parse(Buffer.from(data.Records[record].Data).toString())
              expect(recordData).to.have.property('_datadog')
              expect(recordData._datadog).to.have.property('x-datadog-trace-id')
            }

            done()
          })
        })
      })

      it('handles already b64 encoded data', done => {
        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer.toString('base64'), (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamName, data, (err, data) => {
            if (err) return done(err)

            expect(data).to.have.property('_datadog')
            expect(data._datadog).to.have.property('x-datadog-trace-id')

            done()
          })
        })
      })

      it('skips injecting trace context to Kinesis if message is full', done => {
        const dataBuffer = Buffer.from(JSON.stringify({
          myData: Array(1048576 - 100).join('a')
        }))

        helpers.putTestRecord(kinesis, streamName, dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamName, data, (err, data) => {
            if (err) return done(err)

            expect(data).to.not.have.property('_datadog')

            done()
          })
        })
      })

      it('generates tags for proper input', done => {
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          expect(span.meta).to.include({
            streamname: streamName,
            aws_service: 'Kinesis',
            region: 'us-east-1'
          })
          expect(span.resource).to.equal(`putRecord ${streamName}`)
          expect(span.meta).to.have.property('streamname', streamName)
        }).then(done, done)

        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, e => e && done(e))
      })

      describe('Disabled', () => {
        before(() => {
          process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED = 'false'
        })

        after(() => {
          delete process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED
        })

        it('skip injects trace context to Kinesis putRecord when disabled', done => {
          helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, (err, data) => {
            if (err) return done(err)

            helpers.getTestData(kinesis, streamName, data, (err, data) => {
              if (err) return done(err)

              expect(data).not.to.have.property('_datadog')

              done()
            })
          })
        })
      })
    })

    describe('DSM Context Propagation', () => {
      let expectedProducerHash
      let expectedConsumerHash
      let nowStub
      let streamNameDSM

      beforeEach(() => {
        return agent.load('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      beforeEach(done => {
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })

        streamNameDSM = `MyStreamDSM-${id()}`

        const producerHash = computePathwayHash(
          'test',
          'tester',
          ['direction:out', 'topic:' + streamNameDSM, 'type:kinesis'],
          ENTRY_PARENT_HASH
        )

        expectedProducerHash = producerHash.readBigUInt64LE(0).toString()
        expectedConsumerHash = computePathwayHash(
          'test',
          'tester',
          ['direction:in', 'topic:' + streamNameDSM, 'type:kinesis'],
          producerHash
        ).readBigUInt64LE(0).toString()

        createResources(streamNameDSM, done)
      })

      afterEach(done => {
        kinesis.deleteStream({
          StreamName: streamNameDSM
        }, (err, res) => {
          if (err) return done(err)

          helpers.waitForDeletedStream(kinesis, streamNameDSM, done)
        })
      })

      afterEach(() => {
        try {
          nowStub.restore()
        } catch {
          // pass
        }
        agent.reload('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      it('injects DSM pathway hash during Kinesis getRecord to the span', done => {
        let getRecordSpanMeta = {}
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          if (span.name === 'aws.response') {
            getRecordSpanMeta = span.meta
          }

          expect(getRecordSpanMeta).to.include({
            'pathway.hash': expectedConsumerHash
          })
        }, { timeoutMs: agentTimeout }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, (err) => {
            if (err) return done(err)
          })
        })
      })

      it('injects DSM pathway hash during Kinesis putRecord to the span', done => {
        let putRecordSpanMeta = {}
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          if (span.resource.startsWith('putRecord')) {
            putRecordSpanMeta = span.meta
          }

          expect(putRecordSpanMeta).to.include({
            'pathway.hash': expectedProducerHash
          })
        }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)
        })
      })

      it('emits DSM stats to the agent during Kinesis putRecord', done => {
        agent.expectPipelineStats(dsmStats => {
          let statsPointsReceived = 0
          // we should have only have 1 stats point since we only had 1 put operation
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          })
          expect(statsPointsReceived).to.be.at.least(1)
          expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)
        })
      })

      it('emits DSM stats to the agent during Kinesis getRecord', done => {
        agent.expectPipelineStats(dsmStats => {
          let statsPointsReceived = 0
          // we should have only have 1 stats point since we only had 1 put operation
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          }, { timeoutMs: agentTimeout })
          expect(statsPointsReceived).to.be.at.least(2)
          expect(agent.dsmStatsExist(agent, expectedConsumerHash)).to.equal(true)
        }, { timeoutMs: agentTimeout }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, (err) => {
            if (err) return done(err)
          })
        })
      })

      it('emits DSM stats to the agent during Kinesis getRecord when the putRecord was done without DSM enabled', done => {
        agent.expectPipelineStats(dsmStats => {
          let statsPointsReceived = 0
          // we should have only have 1 stats point since we only had 1 put operation
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          }, { timeoutMs: agentTimeout })
          expect(statsPointsReceived).to.equal(1)
          expect(agent.dsmStatsExistWithParentHash(agent, '0')).to.equal(true)
        }, { timeoutMs: agentTimeout }).then(done, done)

        agent.reload('aws-sdk', { kinesis: { dsmEnabled: false } }, { dsmEnabled: false })
        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          agent.reload('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
          helpers.getTestData(kinesis, streamNameDSM, data, (err) => {
            if (err) return done(err)
          })
        })
      })

      it('emits DSM stats to the agent during Kinesis putRecords', done => {
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
          // we should have only have 3 stats points since we only had 3 records published
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          })
          expect(statsPointsReceived).to.be.at.least(3)
          expect(agent.dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
        }, { timeoutMs: agentTimeout }).then(done, done)

        helpers.putTestRecords(kinesis, streamNameDSM, (err, data) => {
          // Swallow the error as it doesn't matter for this test.
        })
      })
    })
  })
})
