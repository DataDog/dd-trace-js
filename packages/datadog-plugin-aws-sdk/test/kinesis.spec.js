/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup, dsmStatsExist } = require('./spec_helpers')
const helpers = require('./kinesis_helpers')
const { rawExpectedSchema } = require('./kinesis-naming')

describe('Kinesis', function () {
  this.timeout(20000)
  setup()

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let AWS
    let kinesis
    let tracer

    const streamName = 'MyStream'
    const streamNameDSM = 'MyStreamDSM'
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
      before(() => {
        return agent.load('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      before(done => {
        createResources(streamName, done)
      })

      after(done => {
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
        agent.use(traces => {
          const span = traces[0][0]
          expect(span.meta).to.include({
            'streamname': streamName,
            'aws_service': 'Kinesis',
            'region': 'us-east-1'
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
      const expectedProducerHash = '15481393933680799703'
      const expectedConsumerHash = '10538746554122257118'

      before(() => {
        return agent.load('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      before(done => {
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })

        createResources(streamNameDSM, done)
      })

      after(done => {
        kinesis.deleteStream({
          StreamName: streamNameDSM
        }, (err, res) => {
          if (err) return done(err)

          helpers.waitForDeletedStream(kinesis, streamNameDSM, done)
        })
      })

      afterEach(() => agent.reload('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true }))

      it('injects DSM pathway hash during Kinesis putRecord to the span', done => {
        let putRecordSpanMeta = {}
        agent.use(traces => {
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

      it('injects DSM pathway hash during Kinesis getRecord to the span', done => {
        let getRecordSpanMeta = {}
        agent.use(traces => {
          const span = traces[0][0]

          if (span.resource.startsWith('getRecord')) {
            getRecordSpanMeta = span.meta
          }

          expect(getRecordSpanMeta).to.include({
            'pathway.hash': expectedConsumerHash
          })
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, (err, data) => {
            if (err) return done(err)
          })
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
          expect(dsmStatsExist(agent, expectedProducerHash)).to.equal(true)
        }).then(done, done)

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
          }, { timeoutMs: 10000 })
          expect(statsPointsReceived).to.be.at.least(2)
          expect(dsmStatsExist(agent, expectedConsumerHash)).to.equal(true)
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, (err) => {
            if (err) return done(err)
          })
        })
      })
    })
  })
})
