'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let tracer
  let connection
  let channel

  describe('amqplib', () => {
    withVersions('amqplib', 'amqplib', version => {
      beforeEach(() => {
        process.env.DD_DATA_STREAMS_ENABLED = 'true'
        tracer = require('../../dd-trace')
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

        describe('without plugin', () => {
          it('should run commands normally', done => {
            channel.assertQueue('test', {}, () => { done() })
          })
        })

        describe('when using a callback', () => {
          before(() => {
            return agent.load('amqplib')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          describe('when sending commands', () => {
            withPeerService(
              () => tracer,
              'amqplib',
              () => channel.assertQueue('test', {}, () => {}),
              'localhost',
              'out.host'
            )

            it('should do automatic instrumentation for immediate commands', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', expectedSchema.controlPlane.opName)
                  expect(span).to.have.property('service', expectedSchema.controlPlane.serviceName)
                  expect(span).to.have.property('resource', 'queue.declare test')
                  expect(span).to.not.have.property('type')
                  expect(span.meta).to.have.property('span.kind', 'client')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.meta).to.have.property('component', 'amqplib')
                  expect(span.metrics).to.have.property('network.destination.port', 5672)
                }, 2)
                .then(done)
                .catch(done)

              channel.assertQueue('test', {}, () => {})
            })

            it('should do automatic instrumentation for queued commands', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', expectedSchema.controlPlane.opName)
                  expect(span).to.have.property('service', expectedSchema.controlPlane.serviceName)
                  expect(span).to.have.property('resource', 'queue.delete test')
                  expect(span).to.not.have.property('type')
                  expect(span.meta).to.have.property('span.kind', 'client')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.meta).to.have.property('component', 'amqplib')
                  expect(span.metrics).to.have.property('network.destination.port', 5672)
                }, 3)
                .then(done)
                .catch(done)

              channel.assertQueue('test', {}, () => {})
              channel.deleteQueue('test', () => {})
            })

            it('should handle errors', done => {
              let error

              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('error', 1)
                  expect(span.meta).to.have.property(ERROR_TYPE, error.name)
                  expect(span.meta).to.have.property(ERROR_MESSAGE, error.message)
                  expect(span.meta).to.have.property(ERROR_STACK, error.stack)
                  expect(span.meta).to.have.property('component', 'amqplib')
                }, 2)
                .then(done)
                .catch(done)

              try {
                channel.deleteQueue(null, () => {})
              } catch (e) {
                error = e
              }
            })

            withNamingSchema(
              () => channel.assertQueue('test', {}, () => {}),
              rawExpectedSchema.controlPlane
            )
          })

          describe('when publishing messages', () => {
            withPeerService(
              () => tracer,
              'amqplib',
              () => channel.assertQueue('test', {}, () => {}),
              'localhost',
              'out.host'
            )

            it('should do automatic instrumentation', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', expectedSchema.send.opName)
                  expect(span).to.have.property('service', expectedSchema.send.serviceName)
                  expect(span).to.have.property('resource', 'basic.publish exchange routingKey')
                  expect(span).to.not.have.property('type')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.meta).to.have.property('span.kind', 'producer')
                  expect(span.meta).to.have.property('amqp.routingKey', 'routingKey')
                  expect(span.meta).to.have.property('component', 'amqplib')
                  expect(span.metrics).to.have.property('network.destination.port', 5672)
                }, 3)
                .then(done)
                .catch(done)

              channel.assertExchange('exchange', 'direct', {}, () => {})
              channel.publish('exchange', 'routingKey', Buffer.from('content'))
            })

            it('should handle errors', done => {
              let error

              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('error', 1)
                  expect(span.meta).to.have.property(ERROR_TYPE, error.name)
                  expect(span.meta).to.have.property(ERROR_MESSAGE, error.message)
                  expect(span.meta).to.have.property(ERROR_STACK, error.stack)
                  expect(span.meta).to.have.property('component', 'amqplib')
                }, 2)
                .then(done)
                .catch(done)

              try {
                channel.sendToQueue('test', 'invalid')
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
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', expectedSchema.receive.opName)
                  expect(span).to.have.property('service', expectedSchema.receive.serviceName)
                  expect(span).to.have.property('resource', `basic.deliver ${queue}`)
                  expect(span).to.have.property('type', 'worker')
                  expect(span.meta).to.have.property('span.kind', 'consumer')
                  expect(span.meta).to.have.property('amqp.consumerTag', consumerTag)
                  expect(span.meta).to.have.property('component', 'amqplib')
                }, 5)
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
                  expect(tracer.scope().active()).to.be.null
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

                  expect(traceId).to.not.be.undefined
                  expect(parentId).to.not.be.undefined

                  expect(spanContext._traceId.toString(10)).to.equal(traceId)
                  expect(spanContext._parentId.toString(10)).to.equal(parentId)

                  done()
                }, {}, err => err && done(err))
              })
            })

            it('should support null messages', done => {
              channel.assertQueue('queue', {}, () => {
                channel.consume('queue', (event) => {
                  expect(event).to.be.null
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
                  // eslint-disable-next-line n/handle-callback-err
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
            channel.assertQueue('test', {})
              .then(() => {
                expect(tracer.scope().active()).to.be.null
                done()
              })
              .catch(done)
          })
        })

        describe('when data streams monitoring is enabled', function () {
          this.timeout(10000)

          const expectedProducerHash = '17191234428405871432'
          const expectedConsumerHash = '18277095184718602853'

          before(() => {
            tracer = require('../../dd-trace')
            tracer.use('amqplib')
          })

          before(async () => {
            return agent.load('amqplib')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          it('Should emit DSM stats to the agent when sending a message', done => {
            agent.expectPipelineStats(dsmStats => {
              let statsPointsReceived = 0
              // we should have 1 dsm stats points
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

            channel.assertQueue('testDSM', {}, (err, ok) => {
              if (err) return done(err)

              channel.sendToQueue(ok.queue, Buffer.from('DSM pathway test'))
            })
          })

          it('Should emit DSM stats to the agent when receiving a message', done => {
            agent.expectPipelineStats(dsmStats => {
              let statsPointsReceived = 0
              // we should have 2 dsm stats points
              dsmStats.forEach((timeStatsBucket) => {
                if (timeStatsBucket && timeStatsBucket.Stats) {
                  timeStatsBucket.Stats.forEach((statsBuckets) => {
                    statsPointsReceived += statsBuckets.Stats.length
                  })
                }
              })
              expect(statsPointsReceived).to.be.at.least(1)
              expect(agent.dsmStatsExist(agent, expectedConsumerHash)).to.equal(true)
            }, { timeoutMs: 10000 }).then(done, done)

            channel.assertQueue('testDSM', {}, (err, ok) => {
              if (err) return done(err)

              channel.consume(ok.queue, () => {}, {}, (err, ok) => {
                if (err) done(err)
              })
            })
          })

          it('Should set pathway hash tag on a span when producing', (done) => {
            channel.assertQueue('testDSM', {}, (err, ok) => {
              if (err) return done(err)

              channel.sendToQueue(ok.queue, Buffer.from('dsm test'))

              let produceSpanMeta = {}
              agent.use(traces => {
                const span = traces[0][0]

                if (span.resource.startsWith('basic.publish')) {
                  produceSpanMeta = span.meta
                }

                expect(produceSpanMeta).to.include({
                  'pathway.hash': expectedProducerHash
                })
              }, { timeoutMs: 10000 }).then(done, done)
            })
          })

          it('Should set pathway hash tag on a span when consuming', (done) => {
            channel.assertQueue('testDSM', {}, (err, ok) => {
              if (err) return done(err)

              channel.consume(ok.queue, () => {}, {}, (err, ok) => {
                if (err) return done(err)

                let consumeSpanMeta = {}
                agent.use(traces => {
                  const span = traces[0][0]

                  if (span.resource.startsWith('basic.deliver')) {
                    consumeSpanMeta = span.meta
                  }

                  expect(consumeSpanMeta).to.include({
                    'pathway.hash': expectedConsumerHash
                  })
                }, { timeoutMs: 10000 }).then(done, done)
              })
            })
          })
        })
      })

      describe('with configuration', () => {
        after(() => {
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
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-custom-service')
              expect(traces[0][0]).to.have.property('resource', 'queue.declare test')
            }, 2)
            .then(done)
            .catch(done)

          channel.assertQueue('test', {}, () => {})
        })

        withNamingSchema(
          () => channel.assertQueue('test', {}, () => {}),
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
