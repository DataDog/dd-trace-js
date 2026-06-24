'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')
const { callViaPromise, setup, withAwsSdkVersions } = require('./spec_helpers')
const helpers = require('./kinesis_helpers')
const { rawExpectedSchema } = require('./kinesis-naming')

describe('Kinesis', function () {
  this.timeout(10000)
  setup()

  withAwsSdkVersions((version, moduleName, resolvedVersion) => {
    let AWS
    let kinesis

    const kinesisClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-kinesis' : 'aws-sdk'
    // AWS SDK v2 added `.promise()` in 2.3.0; older v2 releases have no promise API to exercise.
    const promisesSupported = moduleName === '@aws-sdk/smithy-client' || semver.gte(resolvedVersion, '2.3.0')

    function createResources (streamName, cb) {
      AWS = require(`../../../versions/${kinesisClientName}@${version}`).get()

      const params = {
        endpoint: 'http://127.0.0.1:4566',
        region: 'us-east-1',
      }

      if (moduleName === '@aws-sdk/smithy-client') {
        const { NodeHttpHandler } = require(`../../../versions/@aws-sdk/node-http-handler@${version}`).get()

        params.requestHandler = new NodeHttpHandler()
      }

      kinesis = new AWS.Kinesis(params)

      kinesis.createStream({
        StreamName: streamName,
        ShardCount: 1,
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
        return agent.load('aws-sdk', {
          kinesis: { dsmEnabled: false, batchPropagationEnabled: true },
        }, {
          dsmEnabled: true,
        })
      })

      beforeEach(done => {
        streamName = `MyStream-${id()}`
        createResources(streamName, done)
      })

      afterEach(done => {
        kinesis.deleteStream({
          StreamName: streamName,
        }, (err, res) => {
          if (err) return done(err)

          helpers.waitForDeletedStream(kinesis, streamName, done)
        })
      })

      withNamingSchema(
        (done) => kinesis.describeStream({
          StreamName: streamName,
        }, (err) => err && done(err)),
        rawExpectedSchema.outbound
      )

      it('injects trace context to Kinesis putRecord', done => {
        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamName, data, (err, data) => {
            if (err) return done(err)

            assert.ok(Object.hasOwn(data, '_datadog'), `Available keys: ${inspect(Object.keys(data))}`)
            assert.ok(
              Object.hasOwn(data._datadog, 'x-datadog-trace-id'),
              `Available keys: ${inspect(Object.keys(data._datadog))}`
            )

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
              assert.ok(Object.hasOwn(recordData, '_datadog'), `Available keys: ${inspect(Object.keys(recordData))}`)
              assert.ok(
                Object.hasOwn(recordData._datadog, 'x-datadog-trace-id'),
                `Available keys: ${inspect(Object.keys(recordData._datadog))}`
              )
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

            assert.ok(Object.hasOwn(data, '_datadog'), `Available keys: ${inspect(Object.keys(data))}`)
            assert.ok(
              Object.hasOwn(data._datadog, 'x-datadog-trace-id'),
              `Available keys: ${inspect(Object.keys(data._datadog))}`
            )

            done()
          })
        })
      })

      it('skips injecting trace context to Kinesis if message is full', done => {
        const dataBuffer = Buffer.from(JSON.stringify({
          myData: Array(1048576 - 100).join('a'),
        }))

        helpers.putTestRecord(kinesis, streamName, dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamName, data, (err, data) => {
            if (err) return done(err)

            assert.ok(!('_datadog' in data))

            done()
          })
        })
      })

      it('generates tags for proper input', done => {
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assertObjectContains(span.meta, {
            streamname: streamName,
            'messaging.system': 'aws_kinesis',
            aws_service: 'Kinesis',
            region: 'us-east-1',
          })
          assert.strictEqual(span.resource, `putRecord ${streamName}`)
          assert.strictEqual(span.meta.streamname, streamName)
        }).then(done, done)

        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, () => {})
      })

      if (promisesSupported) {
        it('should propagate the tracing context from the producer to the consumer with promises', async () => {
          let parentId
          let traceId

          const parentPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(span.resource.startsWith('putRecord'), true)

            parentId = span.span_id.toString()
            traceId = span.trace_id.toString()
          }, { timeoutMs: 10000 })

          const consumerPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(span.name, 'aws.response')
            assert.strictEqual(typeof parentId, 'string')
            assert.strictEqual(span.parent_id.toString(), parentId)
            assert.strictEqual(span.trace_id.toString(), traceId)
          }, { timeoutMs: 10000 })

          const actions = (async () => {
            const putData = await callViaPromise(kinesis, 'putRecord', {
              PartitionKey: id().toString(),
              Data: helpers.dataBuffer,
              StreamName: streamName,
            })

            const { ShardIterator } = await callViaPromise(kinesis, 'getShardIterator', {
              ShardId: putData.ShardId,
              ShardIteratorType: 'AT_SEQUENCE_NUMBER',
              StartingSequenceNumber: putData.SequenceNumber,
              StreamName: streamName,
            })

            await callViaPromise(kinesis, 'getRecords', { ShardIterator })
          })()

          await Promise.all([parentPromise, consumerPromise, actions])
        })
      }

      describe('Disabled', () => {
        let savedKinesisEnv

        before(() => {
          savedKinesisEnv = process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED
          process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED = 'false'
        })

        after(() => {
          if (savedKinesisEnv === undefined) {
            delete process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED
          } else {
            process.env.DD_TRACE_AWS_SDK_KINESIS_ENABLED = savedKinesisEnv
          }
        })

        it('skip injects trace context to Kinesis putRecord when disabled', done => {
          helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, (err, data) => {
            if (err) return done(err)

            helpers.getTestData(kinesis, streamName, data, (err, data) => {
              if (err) return done(err)

              assert.ok(!('_datadog' in data))

              done()
            })
          })
        })
      })
    })
  })
})
