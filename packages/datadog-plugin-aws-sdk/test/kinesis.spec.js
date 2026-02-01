'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')
const { setup } = require('./spec_helpers')
const helpers = require('./kinesis_helpers')
const { rawExpectedSchema } = require('./kinesis-naming')

describe('Kinesis', function () {
  this.timeout(10000)
  setup()

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let AWS
    let kinesis

    const kinesisClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-kinesis' : 'aws-sdk'

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

            assert.ok(Object.hasOwn(data, '_datadog'))
            assert.ok(Object.hasOwn(data._datadog, 'x-datadog-trace-id'))

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
              assert.ok(Object.hasOwn(recordData, '_datadog'))
              assert.ok(Object.hasOwn(recordData._datadog, 'x-datadog-trace-id'))
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

            assert.ok(Object.hasOwn(data, '_datadog'))
            assert.ok(Object.hasOwn(data._datadog, 'x-datadog-trace-id'))

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
            aws_service: 'Kinesis',
            region: 'us-east-1',
          })
          assert.strictEqual(span.resource, `putRecord ${streamName}`)
          assert.strictEqual(span.meta.streamname, streamName)
        }).then(done, done)

        helpers.putTestRecord(kinesis, streamName, helpers.dataBuffer, () => {})
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

              assert.ok(!('_datadog' in data))

              done()
            })
          })
        })
      })
    })
  })
})
