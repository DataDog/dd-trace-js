/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const helpers = require('./kinesis_helpers')
const { rawExpectedSchema } = require('./kinesis-naming')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')

const expectedProducerHash = computePathwayHash(
  'test',
  'tester',
  ['direction:out', 'topic:MyStreamDSM', 'type:kinesis'],
  ENTRY_PARENT_HASH
)

const expectedConsumerHash = computePathwayHash(
  'test',
  'tester',
  ['direction:in', 'topic:MyStreamDSM', 'type:kinesis'],
  expectedProducerHash
)

describe('Kinesis', function () {
  this.timeout(10000)
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
        return agent.load('aws-sdk', { kinesis: { dsmEnabled: false } }, { dsmEnabled: true })
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

      it('injects DSM pathway hash during Kinesis putRecord to the span', done => {
        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          let putRecordSpanMeta = {}
          agent.use(traces => {
            const span = traces[0][0]

            if (span.resource.startsWith('putRecord')) {
              putRecordSpanMeta = span.meta
            }

            expect(putRecordSpanMeta).to.include({
              'pathway.hash': expectedProducerHash.readBigUInt64BE(0).toString()
            })
          }).then(done, done)
        })
      })

      describe('emits a new DSM Stats to the agent when DSM is enabled', () => {
        before(done => {
          helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
            if (err) return done(err)
  
            helpers.getTestData(kinesis, streamNameDSM, data, (err, data) => {
              if (err) return done(err)

              tracer._tracer._dataStreamsProcessor.onInterval()

              const intervalId = setInterval(() => {
                if (agent.getDsmStats().length >= 1) {
                  clearInterval(intervalId)
                  done()
                }
              }, 100)
            })
          })
        })

        it('when putting a record', done => {
          const dsmStats = agent.getDsmStats()
          if (dsmStats.length !== 0) {
            dsmStats.forEach((statsTimeBucket) => {
              statsTimeBucket.Stats.forEach((statsBucket) => {
                statsBucket.Stats.forEach((stats) => {
                  if (stats.Hash.toString() === expectedProducerHash.readBigUInt64BE(0).toString()) {
                    done()
                  }
                })
              })
            })
          }
        })
      })
    })
  })
})
