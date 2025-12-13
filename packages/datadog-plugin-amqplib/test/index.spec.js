'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const id = require('../../dd-trace/src/id')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
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

      describe('without configuration', () => {
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

        describe('without plugin', () => {
          it('should run commands normally', done => {
            channel.assertQueue(queue, {}, () => { done() })
          })
        })

        describe('when using a callback', () => {
          describe('when sending commands', () => {
            withPeerService(
              () => tracer,
              'amqplib',
              (done) => channel.assertQueue(queue, {}, done),
              'localhost',
              'out.host'
            )

            it('should do automatic instrumentation for immediate commands', done => {
              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]
                  assert.strictEqual(span.name, expectedSchema.controlPlane.opName)
                  assert.strictEqual(span.service, expectedSchema.controlPlane.serviceName)
                  assert.strictEqual(span.resource, `queue.declare ${queue}`)
                  assert.ok(!('type' in span))
                  assert.strictEqual(span.meta['span.kind'], 'client')
                  assert.strictEqual(span.meta['out.host'], 'localhost')
                  assert.strictEqual(span.meta.component, 'amqplib')
                  assert.strictEqual(span.meta['_dd.integration'], 'amqplib')
                  assert.strictEqual(span.metrics['network.destination.port'], 5672)
                })
                .then(done)
                .catch(done)

              channel.assertQueue(queue, {}, () => {})
            })

            it('should do automatic instrumentation for queued commands', done => {
              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  assert.strictEqual(span.name, expectedSchema.controlPlane.opName)
                  assert.strictEqual(span.service, expectedSchema.controlPlane.serviceName)
                  assert.strictEqual(span.resource, `queue.delete ${queue}`)
                  assert.ok(!('type' in span))
                  assert.strictEqual(span.meta['span.kind'], 'client')
                  assert.strictEqual(span.meta['out.host'], 'localhost')
                  assert.strictEqual(span.meta.component, 'amqplib')
                  assert.strictEqual(span.metrics['network.destination.port'], 5672)
                })
                .then(done)
                .catch(done)

              channel.assertQueue(queue, {}, () => {})
              channel.deleteQueue(queue, () => {})
            })

            it('should handle errors', done => {
              let error

              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  assert.strictEqual(span.error, 1)
                  assert.strictEqual(span.meta[ERROR_TYPE], error.name)
                  assert.strictEqual(span.meta[ERROR_MESSAGE], error.message)
                  assert.strictEqual(span.meta[ERROR_STACK], error.stack)
                  assert.strictEqual(span.meta.component, 'amqplib')
                })
                .then(done)
                .catch(done)

              try {
                channel.deleteQueue(null, () => {})
              } catch (e) {
                error = e
              }
            })

            withNamingSchema(
              () => channel.assertQueue(queue, {}, () => {}),
              rawExpectedSchema.controlPlane
            )
          })

          describe('when publishing messages', () => {
            withPeerService(
              () => tracer,
              'amqplib',
              (done) => channel.assertQueue(queue, {}, done),
              'localhost',
              'out.host'
            )

            it('should do automatic instrumentation', done => {
              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  assert.strictEqual(span.name, expectedSchema.send.opName)
                  assert.strictEqual(span.service, expectedSchema.send.serviceName)
                  assert.strictEqual(span.resource, 'basic.publish exchange routingKey')
                  assert.ok(!('type' in span))
                  assert.strictEqual(span.meta['out.host'], 'localhost')
                  assert.strictEqual(span.meta['span.kind'], 'producer')
                  assert.strictEqual(span.meta['amqp.routingKey'], 'routingKey')
                  assert.strictEqual(span.meta.component, 'amqplib')
                  assert.strictEqual(span.metrics['network.destination.port'], 5672)
                })
                .then(done)
                .catch(done)

              channel.assertExchange('exchange', 'direct', {}, () => {})
              channel.publish('exchange', 'routingKey', Buffer.from('content'))
            })

            it('should handle errors', done => {
              let error

              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  assert.strictEqual(span.error, 1)
                  assert.strictEqual(span.meta[ERROR_TYPE], error.name)
                  assert.strictEqual(span.meta[ERROR_MESSAGE], error.message)
                  assert.strictEqual(span.meta[ERROR_STACK], error.stack)
                  assert.strictEqual(span.meta.component, 'amqplib')
                })
                .then(done)
                .catch(done)

              try {
                channel.sendToQueue(queue, 'invalid')
              } catch (e) {
                error = e
              }
            })

            withNamingSchema(
              () => {
                channel.assertExchange('exchange', 'direct', {}, () => {})
                channel.publish('exchange', 'routingKey', Buffer.from('content'))
              },
              rawExpectedSchema.send
            )
          })

          describe('when consuming messages', () => {
            it('should do automatic instrumentation', done => {
              let consumerTag
              let queue

              agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]
                  assert.strictEqual(span.name, expectedSchema.receive.opName)
                  assert.strictEqual(span.service, expectedSchema.receive.serviceName)
                  assert.strictEqual(span.resource, `basic.deliver ${queue}`)
                  assert.strictEqual(span.type, 'worker')
                  assert.strictEqual(span.meta['span.kind'], 'consumer')
                  assert.strictEqual(span.meta['amqp.consumerTag'], consumerTag)
                  assert.strictEqual(span.meta.component, 'amqplib')
                })
                .then(done)
                .catch(done)

              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                queue = ok.queue

                channel.sendToQueue(ok.queue, Buffer.from('content'))
                channel.consume(ok.queue, () => {}, {}, (err, ok) => {
                  if (err) return done(err)
                  consumerTag = ok.consumerTag
                })
              })
            })

            it('should run the command callback in the parent context', done => {
              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                channel.consume(ok.queue, () => {}, {}, () => {
                  assert.strictEqual(tracer.scope().active(), null)
                  done()
                })
              })
            })

            it('should run the delivery callback in the producer context', done => {
              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                channel.sendToQueue(ok.queue, Buffer.from('content'))
                channel.consume(ok.queue, msg => {
                  const traceId = msg.properties.headers['x-datadog-trace-id']
                  const parentId = msg.properties.headers['x-datadog-parent-id']
                  const spanContext = tracer.scope().active().context()

                  assert.notStrictEqual(traceId, undefined)
                  assert.notStrictEqual(parentId, undefined)

                  assert.strictEqual(spanContext._traceId.toString(10), traceId)
                  assert.strictEqual(spanContext._parentId.toString(10), parentId)

                  done()
                }, {}, err => err && done(err))
              })
            })

            it('should support null messages', done => {
              channel.assertQueue('queue', {}, () => {
                channel.consume('queue', (event) => {
                  assert.strictEqual(event, null)
                  done()
                }, {}, () => {
                  channel.deleteQueue('queue')
                })
              })
            })

            withNamingSchema(
              () => {
                channel.assertQueue('', {}, (err, ok) => {
                  if (err) return
                  channel.sendToQueue(ok.queue, Buffer.from('content'))
                  channel.consume(ok.queue, () => {}, {}, (err, ok) => {})
                })
              },
              rawExpectedSchema.receive
            )
          })
        })

        describe('when using a promise', () => {
          beforeEach(() => {
            return require(`../../../versions/amqplib@${version}`).get().connect()
              .then(conn => (connection = conn))
              .then(conn => conn.createChannel())
              .then(ch => (channel = ch))
          })

          it('should run the callback in the parent context', done => {
            channel.assertQueue(queue, {})
              .then(() => {
                assert.strictEqual(tracer.scope().active(), null)
                done()
              })
              .catch(done)
          })
        })

        describe('when data streams monitoring is enabled', function () {
          this.timeout(10000)

          let expectedProducerHashWithTopic
          let expectedProducerHashWithExchange
          let expectedConsumerHash

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

      describe('with configuration', () => {
        afterEach(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          agent.load('amqplib', { service: 'test-custom-service' }).then(() => {
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

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'test-custom-service')
              assert.strictEqual(traces[0][0].resource, `queue.declare ${queue}`)
            })
            .then(done)
            .catch(done)

          channel.assertQueue(queue, {}, () => {})
        })

        withNamingSchema(
          () => channel.assertQueue(queue, {}, () => {}),
          {
            v0: {
              opName: 'amqp.command',
              serviceName: 'test-custom-service'
            },
            v1: {
              opName: 'amqp.command',
              serviceName: 'test-custom-service'
            }
          }
        )
      })
    })
  })
})
