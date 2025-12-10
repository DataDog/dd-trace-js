'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const id = require('../../dd-trace/src/id')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

describe('Plugin', () => {
  let tracer
  let connection
  let channel
  let queue

  describe('amqplib', () => {
    withVersions('amqplib', 'amqplib', version => {
      beforeEach(() => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        tracer = require('../../dd-trace')
        queue = `test-${id()}`
      })

      afterEach(() => {
        connection.close()
      })

      describe('data stream monitoring', function () {
        this.timeout(10000)

        let expectedProducerHashWithTopic
        let expectedProducerHashWithExchange
        let expectedConsumerHash

        beforeEach(done => {
          agent.load('amqplib').then(() => {
            require(`../../../versions/amqplib@${version}`).get('amqplib/callback_api')
              .connect((err, conn) => {
                connection = conn

                if (err != null) {
                  return done(err)
                }

                conn.createChannel((err, ch) => {
                  channel = ch
                  return done(err)
                })
              })
          })
        })

        afterEach(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          const producerHashWithTopic = computePathwayHash('test', 'tester', [
            'direction:out',
            'has_routing_key:true',
            `topic:${queue}`,
            'type:rabbitmq'
          ], ENTRY_PARENT_HASH)

          expectedProducerHashWithTopic = producerHashWithTopic.readBigUInt64LE(0).toString()

          expectedProducerHashWithExchange = computePathwayHash('test', 'tester', [
            'direction:out',
            'exchange:namedExchange',
            'has_routing_key:true',
            'type:rabbitmq'
          ], ENTRY_PARENT_HASH).readBigUInt64LE(0).toString()

          expectedConsumerHash = computePathwayHash('test', 'tester', [
            'direction:in',
            `topic:${queue}`,
            'type:rabbitmq'
          ], producerHashWithTopic).readBigUInt64LE(0).toString()
        })

        it('Should emit DSM stats to the agent when sending a message on an unnamed exchange', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            // we should have 1 dsm stats points
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
              'has_routing_key:true',
              `topic:${queue}`,
              'type:rabbitmq'
            ])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHashWithTopic), true)
          }, { timeoutMs: 10000 }).then(done, done)

          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('DSM pathway test'))
          })
        })

        it('Should emit DSM stats to the agent when sending a message on an named exchange', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            // we should have 1 dsm stats points
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
              'exchange:namedExchange',
              'has_routing_key:true',
              'type:rabbitmq'
            ])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHashWithExchange), true)
          }, { timeoutMs: 10000 }).then(done, done)

          channel.assertExchange('namedExchange', 'direct', {}, (err, ok) => {
            if (err) return done(err)

            channel.publish('namedExchange', 'anyOldRoutingKey', Buffer.from('DSM pathway test'))
          })
        })

        it('Should emit DSM stats to the agent when receiving a message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            // we should have 2 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived = statsPointsReceived.concat(statsBuckets.Stats)
                })
              }
            })
            assert.strictEqual(statsPointsReceived.length, 2)
            assert.deepStrictEqual(statsPointsReceived[1].EdgeTags,
              ['direction:in', `topic:${queue}`, 'type:rabbitmq'])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
          }, { timeoutMs: 10000 }).then(done, done)

          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('DSM pathway test'))
            channel.consume(ok.queue, () => {}, {}, (err, ok) => {
              if (err) done(err)
            })
          })
        })

        it('Should emit DSM stats to the agent when sending another message', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            // we should have 1 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived = statsPointsReceived.concat(statsBuckets.Stats)
                })
              }
            })
            assert.strictEqual(statsPointsReceived.length, 1)
            assert.deepStrictEqual(statsPointsReceived[0].EdgeTags, [
              'direction:out',
              'has_routing_key:true',
              `topic:${queue}`,
              'type:rabbitmq'
            ])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHashWithTopic), true)
          }, { timeoutMs: 10000 }).then(done, done)

          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('DSM pathway test'))
          })
        })

        it('Should emit DSM stats to the agent when receiving a message with get', done => {
          agent.expectPipelineStats(dsmStats => {
            let statsPointsReceived = []
            // we should have 2 dsm stats points
            dsmStats.forEach((timeStatsBucket) => {
              if (timeStatsBucket && timeStatsBucket.Stats) {
                timeStatsBucket.Stats.forEach((statsBuckets) => {
                  statsPointsReceived = statsPointsReceived.concat(statsBuckets.Stats)
                })
              }
            })
            assert.strictEqual(statsPointsReceived.length, 2)
            assert.deepStrictEqual(statsPointsReceived[1].EdgeTags,
              ['direction:in', `topic:${queue}`, 'type:rabbitmq'])
            assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
          }, { timeoutMs: 10000 }).then(done, done)

          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('DSM pathway test'))
            channel.get(ok.queue, {}, (err, ok) => {
              if (err) done(err)
            })
          })
        })

        it('regression test: should handle basic.get when queue is empty', done => {
          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.get(ok.queue, {}, (err, msg) => {
              if (err) return done(err)
              assert.strictEqual(msg, false)
              done()
            })
          })
        })

        it('Should set pathway hash tag on a span when producing', (done) => {
          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('dsm test'))

            let produceSpanMeta = {}
            agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              if (span.resource.startsWith('basic.publish')) {
                produceSpanMeta = span.meta
              }

              assertObjectContains(produceSpanMeta, {
                'pathway.hash': expectedProducerHashWithTopic
              })
            }, { timeoutMs: 10000 }).then(done, done)
          })
        })

        it('Should set pathway hash tag on a span when consuming', (done) => {
          channel.assertQueue(queue, {}, (err, ok) => {
            if (err) return done(err)

            channel.sendToQueue(ok.queue, Buffer.from('dsm test'))
            channel.consume(ok.queue, () => {}, {}, (err, ok) => {
              if (err) return done(err)

              let consumeSpanMeta = {}
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                if (span.resource.startsWith('basic.deliver')) {
                  consumeSpanMeta = span.meta
                }

                assertObjectContains(consumeSpanMeta, {
                  'pathway.hash': expectedConsumerHash
                })
              }, { timeoutMs: 10000 }).then(done, done)
            })
          })
        })
      })
    })
  })
})

