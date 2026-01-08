'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const id = require('../../dd-trace/src/id')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

describe('Plugin', () => {
  let Queue
  let queue
  let queueName

  describe('bee-queue', () => {
    withVersions('bee-queue', 'bee-queue', version => {
      beforeEach(() => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        queueName = `test-${id()}`
      })

      afterEach(async () => {
        try {
          if (queue) await queue.close()
        } catch (e) {
          // Ignore cleanup errors
        }
      })

      describe('data stream monitoring', function () {
        this.timeout(10000)

        let expectedProducerHash
        let expectedConsumerHash

        beforeEach(async () => {
          await agent.load('bee-queue')
          Queue = require(`../../../versions/bee-queue@${version}`).get()
          queue = new Queue(queueName, {
            redis: {
              host: '127.0.0.1',
              port: 6379
            },
            isWorker: true,
            removeOnSuccess: true
          })

          // Handle errors to prevent unhandled rejections
          queue.on('error', () => {})
        })

        afterEach(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          const producerHash = computePathwayHash('test', 'tester', [
            'direction:out',
            `topic:${queueName}`,
            'type:bee-queue'
          ], ENTRY_PARENT_HASH)

          expectedProducerHash = producerHash.readBigUInt64LE(0).toString()

          expectedConsumerHash = computePathwayHash('test', 'tester', [
            'direction:in',
            `topic:${queueName}`,
            'type:bee-queue'
          ], producerHash).readBigUInt64LE(0).toString()
        })

        it('Should emit DSM stats to the agent when producing a message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived = statsPointsReceived.concat(statsBuckets.Stats)
                })
              }
            })
            assert.ok(statsPointsReceived.length >= 1)
            assert.deepStrictEqual(statsPointsReceived[0].EdgeTags, [
              'direction:out',
              `topic:${queueName}`,
              'type:bee-queue'
            ])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash), true)
          }, { timeoutMs: 10000 }).then(done, done)

          const job = queue.createJob({ x: 1, y: 2 })
          job.save()
        })

        it('Should emit DSM stats to the agent when consuming a message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived = statsPointsReceived.concat(statsBuckets.Stats)
                })
              }
            })
            assert.strictEqual(statsPointsReceived.length, 2)
            assert.deepStrictEqual(statsPointsReceived[1].EdgeTags,
              ['direction:in', `topic:${queueName}`, 'type:bee-queue'])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
          }, { timeoutMs: 10000 }).then(done, done)

          queue.process(async (job) => {
            return { result: 'success' }
          })

          const job = queue.createJob({ x: 1, y: 2 })
          job.save()
        })

        it('Should set pathway hash tag on a span when producing', done => {
          let produceSpanMeta = {}
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            if (span.name === 'bee-queue.save') {
              produceSpanMeta = span.meta
            }
            assertObjectContains(produceSpanMeta, {
              'pathway.hash': expectedProducerHash
            })
          }, { timeoutMs: 10000 }).then(done, done)

          const job = queue.createJob({ x: 1, y: 2 })
          job.save()
        })

        it('Should set pathway hash tag on a span when consuming', done => {
          let consumeSpanMeta = {}
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            if (span.name === 'bee-queue._runJob') {
              consumeSpanMeta = span.meta
            }
            assertObjectContains(consumeSpanMeta, {
              'pathway.hash': expectedConsumerHash
            })
          }, { timeoutMs: 10000 }).then(done, done)

          queue.process(async (job) => {
            return { result: 'success' }
          })

          const job = queue.createJob({ x: 1, y: 2 })
          job.save()
        })
      })
    })
  })
})
