'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const propagationHash = require('../../dd-trace/src/propagation-hash')
const helpers = require('./kinesis_helpers')
const { callViaPromise, setup, withAwsSdkVersions } = require('./spec_helpers')

describe('Kinesis', function () {
  this.timeout(10000)
  setup()

  withAwsSdkVersions((version, moduleName, resolvedVersion) => {
    let AWS
    let kinesis
    let tracer

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

        const phash = propagationHash.getHash()
        const producerHash = computePathwayHash(
          'test',
          'tester',
          ['direction:out', 'topic:' + streamNameDSM, 'type:kinesis'],
          ENTRY_PARENT_HASH,
          phash
        )

        expectedProducerHash = producerHash.readBigUInt64LE(0).toString()
        expectedConsumerHash = computePathwayHash(
          'test',
          'tester',
          ['direction:in', 'topic:' + streamNameDSM, 'type:kinesis'],
          producerHash,
          phash
        ).readBigUInt64LE(0).toString()

        createResources(streamNameDSM, done)
      })

      afterEach(done => {
        kinesis.deleteStream({
          StreamName: streamNameDSM,
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

          assertObjectContains(getRecordSpanMeta, {
            'pathway.hash': expectedConsumerHash,
          })
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, () => {})
        })
      })

      if (promisesSupported) {
        // Two Limit:1 polls: the first consumer span gets its topic from the stored iterator,
        // the second from the re-keyed NextShardIterator. A broken re-key drops below two.
        it('injects DSM pathway hash on consumer spans across promise-based getRecords polls', async () => {
          const consumerSpanIds = new Set()
          const tracePromise = agent.assertSomeTraces(traces => {
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name === 'aws.response' && span.meta['pathway.hash'] === expectedConsumerHash) {
                  consumerSpanIds.add(span.span_id.toString())
                }
              }
            }

            assert.ok(consumerSpanIds.size >= 2, `Expected >= 2 consumer spans, got ${consumerSpanIds.size}`)
          }, { timeoutMs: 10000 })

          const actions = (async () => {
            const first = await callViaPromise(kinesis, 'putRecord', {
              PartitionKey: id().toString(),
              Data: helpers.dataBuffer,
              StreamName: streamNameDSM,
            })
            await callViaPromise(kinesis, 'putRecord', {
              PartitionKey: id().toString(),
              Data: helpers.dataBuffer,
              StreamName: streamNameDSM,
            })

            const { ShardIterator } = await callViaPromise(kinesis, 'getShardIterator', {
              ShardId: first.ShardId,
              ShardIteratorType: 'AT_SEQUENCE_NUMBER',
              StartingSequenceNumber: first.SequenceNumber,
              StreamName: streamNameDSM,
            })

            const firstPoll = await callViaPromise(kinesis, 'getRecords', { ShardIterator, Limit: 1 })
            await callViaPromise(kinesis, 'getRecords', { ShardIterator: firstPoll.NextShardIterator, Limit: 1 })
          })()

          await Promise.all([tracePromise, actions])
        })
      }

      it('injects DSM pathway hash during Kinesis putRecord to the span', done => {
        let putRecordSpanMeta = {}
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          if (span.resource.startsWith('putRecord')) {
            putRecordSpanMeta = span.meta
          }

          assertObjectContains(putRecordSpanMeta, {
            'pathway.hash': expectedProducerHash,
          })
        }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, () => {})
      })

      // Regression: a record whose payload only clears the 1 MiB Kinesis cap once the trace
      // context is attached must not record a produce checkpoint — the context can never ship,
      // so the size gate bails before `setDSMCheckpoint` and the `putRecord` span carries no
      // `pathway.hash`.
      it('records no DSM checkpoint when attaching context would exceed the 1 MiB cap', done => {
        // Fits under the cap on its own; adding `_datadog` tips it over.
        const overCapAfterInject = Buffer.from(JSON.stringify({ myData: 'a'.repeat(1048576 - 100) }))

        agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.match(span.resource, /^putRecord/)
          assert.strictEqual(span.meta['pathway.hash'], undefined)
        }, { spanResourceMatch: /^putRecord/ }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, overCapAfterInject, () => {})
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
          assert.ok(statsPointsReceived >= 1, `Expected ${statsPointsReceived} >= 1`)
          assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, () => {})
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
          assert.ok(statsPointsReceived >= 2, `Expected ${statsPointsReceived} >= 2`)
          assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          helpers.getTestData(kinesis, streamNameDSM, data, () => {})
        })
      })

      // eslint-disable-next-line @stylistic/max-len
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
          }, { timeoutMs: 10000 })
          assert.strictEqual(statsPointsReceived, 1)
          assert.strictEqual(agent.dsmStatsExistWithParentHash(agent, '0'), true)
        }, { timeoutMs: 10000 }).then(done, done)

        // TODO: Fix this. The third argument is not used. Check all usages of agent.reload.
        agent.reload('aws-sdk', { kinesis: { dsmEnabled: false } }, { dsmEnabled: false })
        helpers.putTestRecord(kinesis, streamNameDSM, helpers.dataBuffer, (err, data) => {
          if (err) return done(err)

          // TODO: Fix this. The third argument is not used. Check all usages of agent.reload.
          agent.reload('aws-sdk', { kinesis: { dsmEnabled: true } }, { dsmEnabled: true })
          helpers.getTestData(kinesis, streamNameDSM, data, () => {})
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
          assert.ok(statsPointsReceived >= 3, `Expected ${statsPointsReceived} >= 3`)
          assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
        }, { timeoutMs: 10000 }).then(done, done)

        helpers.putTestRecords(kinesis, streamNameDSM, (err, data) => {
          // Swallow the error as it doesn't matter for this test.
        })
      })
    })
  })
})
