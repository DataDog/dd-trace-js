'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')

const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const propagationHash = require('../../dd-trace/src/propagation-hash')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup, withAwsSdkVersions } = require('./spec_helpers')

describe('EventBridge', function () {
  setup()
  this.timeout(20000)

  withAwsSdkVersions((version, moduleName) => {
    let eventbridge
    let tracer

    const ebClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-eventbridge' : 'aws-sdk'

    const putEntry = (overrides = {}) => ({
      Source: 'dd.test',
      DetailType: 'dsmTest',
      Detail: JSON.stringify({ hello: 'world' }),
      EventBusName: 'default',
      ...overrides,
    })

    describe('Data Streams Monitoring', () => {
      let expectedProducerHash
      let nowStub

      before(() => {
        return agent.load('aws-sdk', { eventbridge: { dsmEnabled: true } }, { dsmEnabled: true })
      })

      before(() => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { eventbridge: { dsmEnabled: true } })

        const { EventBridge } = require(`../../../versions/${ebClientName}@${version}`).get()
        eventbridge = new EventBridge({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

        // The DSM "topic" is the target event bus; the default bus is `default`.
        const phash = propagationHash.getHash()
        expectedProducerHash = computePathwayHash(
          'test', 'tester',
          ['direction:out', 'topic:default', 'type:eventbridge'],
          ENTRY_PARENT_HASH,
          phash
        ).readBigUInt64LE(0).toString()
      })

      afterEach(() => {
        try {
          nowStub.restore()
        } catch {
          // pass
        }
      })

      after(() => {
        return agent.close()
      })

      it('emits a producer pathway hash to the putEvents span', done => {
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          if (span.meta?.['pathway.hash']) {
            assert.strictEqual(span.meta['pathway.hash'], expectedProducerHash)
          }
        }).then(done, done)

        eventbridge.putEvents({ Entries: [putEntry()] }, () => {})
      })

      it('outputs DSM stats to the agent when putting events', done => {
        agent.expectPipelineStats(dsmStats => {
          let statsPointsReceived = 0
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          })
          assert.ok(statsPointsReceived >= 1, `Expected ${statsPointsReceived} >= 1`)
          assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
        }).then(done, done)

        eventbridge.putEvents({ Entries: [putEntry()] }, () => {})
      })

      it('outputs a DSM stats point for every entry when batchPropagationEnabled', done => {
        // Stub Date.now() so each checkpoint lands in its own stats bucket
        // instead of being merged into one point.
        let now = Date.now()
        nowStub = sinon.stub(Date, 'now')
        nowStub.callsFake(() => {
          now += 1_000_000
          return now
        })

        agent.expectPipelineStats(dsmStats => {
          let statsPointsReceived = 0
          dsmStats.forEach((timeStatsBucket) => {
            if (timeStatsBucket && timeStatsBucket.Stats) {
              timeStatsBucket.Stats.forEach((statsBuckets) => {
                statsPointsReceived += statsBuckets.Stats.length
              })
            }
          })
          assert.ok(statsPointsReceived >= 3, `Expected ${statsPointsReceived} >= 3`)
          assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
        }, { timeoutMs: 2000 }).then(done, done)

        tracer.use('aws-sdk', { eventbridge: { dsmEnabled: true, batchPropagationEnabled: true } })
        eventbridge.putEvents({
          Entries: [
            putEntry({ Detail: JSON.stringify({ order: 1 }) }),
            putEntry({ Detail: JSON.stringify({ order: 2 }) }),
            putEntry({ Detail: JSON.stringify({ order: 3 }) }),
          ],
        }, () => {
          nowStub.restore()
        })
      })
    })
  })
})
