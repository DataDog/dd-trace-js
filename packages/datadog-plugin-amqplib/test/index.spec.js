'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')

const namingSchema = require('./naming')

describe('Plugin', () => {
  let tracer
  let connection
  let channel

  describe('amqplib', () => {
    withVersions('amqplib', 'amqplib', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        connection.close()
      })

      describe('without configuration', () => {
        beforeEach(done => {
          require(`../../../versions/amqplib@${version}`).get('amqplib/callback_api')
            .connect((err, conn) => {
              connection = conn

              if (err != null) {
                return done(err)
              }

              conn.createChannel((err, ch) => {
                channel = ch
                done(err)
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
            it('should do automatic instrumentation for immediate commands', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', namingSchema.controlPlane.opName)
                  expect(span).to.have.property('service', namingSchema.controlPlane.serviceName)
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

                  expect(span).to.have.property('name', namingSchema.controlPlane.opName)
                  expect(span).to.have.property('service', namingSchema.controlPlane.serviceName)
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
              () => namingSchema.controlPlane.opName,
              () => namingSchema.controlPlane.serviceName
            )
          })

          describe('when publishing messages', () => {
            it('should do automatic instrumentation', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', namingSchema.send.opName)
                  expect(span).to.have.property('service', namingSchema.send.serviceName)
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
              () => namingSchema.send.opName,
              () => namingSchema.send.serviceName
            )
          })

          describe('when consuming messages', () => {
            it('should do automatic instrumentation', done => {
              let consumerTag
              let queue

              agent
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', namingSchema.receive.opName)
                  expect(span).to.have.property('service', namingSchema.receive.serviceName)
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
                  channel.consume(ok.queue, () => {}, {}, (err, ok) => {})
                })
              },
              () => namingSchema.receive.opName,
              () => namingSchema.receive.serviceName
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
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('amqplib', { service: 'test-custom-service' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          require(`../../../versions/amqplib@${version}`).get('amqplib/callback_api')
            .connect((err, conn) => {
              connection = conn

              if (err !== null) {
                return done(err)
              }

              conn.createChannel((err, ch) => {
                channel = ch
                done(err)
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
          () => namingSchema.controlPlane.opName,
          () => 'test-custom-service'
        )
      })
    })
  })
})
