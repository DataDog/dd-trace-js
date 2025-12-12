'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const id = require('../../dd-trace/src/id')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

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
                  assert.ok(!Object.hasOwn(span, 'type'))
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
                  assert.ok(!Object.hasOwn(span, 'type'))
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
                  assert.ok(!Object.hasOwn(span, 'type'))
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
