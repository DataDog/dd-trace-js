'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const namingSchema = require('./naming')

describe('Plugin', () => {
  let tracer

  describe('rhea', () => {
    before(() => agent.load('rhea'))
    after(() => agent.close({ ritmReset: false }))

    withVersions('rhea', 'rhea', version => {
      describe('with broker', () => {
        let container
        let context

        beforeEach(() => {
          tracer = require('../../dd-trace')
        })

        afterEach((done) => {
          context.connection.once('connection_close', () => done())
          context.connection.close()
        })

        describe('without configuration', () => {
          beforeEach(() => agent.reload('rhea'))

          beforeEach(done => {
            container = require(`../../../versions/rhea@${version}`).get()

            container.once('sendable', _context => {
              context = _context
              done()
            })
            const connection = container.connect({
              username: 'admin',
              password: 'admin',
              host: 'localhost',
              port: 5673
            })
            connection.open_sender('amq.topic')
            connection.open_receiver('amq.topic')
          })

          describe('sending a message', () => {
            it('should automatically instrument', (done) => {
              agent.use(traces => {
                const span = traces[0][0]
                expect(span).to.include({
                  name: namingSchema.send.opName,
                  resource: 'amq.topic',
                  error: 0,
                  service: namingSchema.send.serviceName
                })
                expect(span).to.not.have.property('type')
                expect(span.meta).to.include({
                  'span.kind': 'producer',
                  'amqp.link.target.address': 'amq.topic',
                  'amqp.link.role': 'sender',
                  'amqp.delivery.state': 'accepted',
                  'out.host': 'localhost',
                  'component': 'rhea'
                })
                expect(span.metrics).to.include({
                  'network.destination.port': 5673
                })
              })
                .then(done, done)
              context.sender.send({ body: 'Hello World!' })
            })

            it('should inject span context', (done) => {
              container.once('message', msg => {
                const keys = Object.keys(msg.message.delivery_annotations)
                expect(keys).to.include('x-datadog-trace-id')
                expect(keys).to.include('x-datadog-parent-id')
                done()
              })
              context.sender.send({ body: 'Hello World!' })
            })

            it('should inject span context with encoded messages', (done) => {
              container.once('message', msg => {
                const keys = Object.keys(msg.message.delivery_annotations)
                expect(keys).to.include('x-datadog-trace-id')
                expect(keys).to.include('x-datadog-parent-id')
                done()
              })
              tracer.trace('web.request', () => {
                const encodedMessage = container.message.encode({ body: 'Hello World!' })
                context.sender.send(encodedMessage, undefined, 0)
              })
            })

            withNamingSchema(
              () => { context.sender.send({ body: 'Hello World!' }) },
              () => namingSchema.send.opName, () => namingSchema.send.serviceName
            )
          })

          describe('receiving a message', () => {
            it('should automatically instrument', done => {
              agent.use(traces => {
                const span = traces[0][0]
                expect(span).to.include({
                  name: namingSchema.receive.opName,
                  resource: 'amq.topic',
                  error: 0,
                  service: namingSchema.receive.serviceName,
                  type: 'worker'
                })
                expect(span.meta).to.include({
                  'span.kind': 'consumer',
                  'amqp.link.source.address': 'amq.topic',
                  'amqp.link.role': 'receiver',
                  'component': 'rhea'
                })
              })
                .then(done, done)
              context.sender.send({ body: 'Hello World!' })
            })

            it('should extract the span context', done => {
              container.once('message', msg => {
                const span = tracer.scope().active()
                expect(span._spanContext._parentId).to.not.be.null
                done()
              })
              context.sender.send({ body: 'Hello World!' })
            })

            withNamingSchema(
              () => { context.sender.send({ body: 'Hello World!' }) },
              () => namingSchema.receive.opName,
              () => namingSchema.receive.serviceName
            )
          })
        })

        describe('with configuration', () => {
          beforeEach(() => agent.reload('rhea', {
            service: 'a_test_service'
          }))

          beforeEach(done => {
            container = require(`../../../versions/rhea@${version}`).get()

            container.once('sendable', function (_context) {
              context = _context
              done()
            })
            const connection = container.connect({
              username: 'admin',
              password: 'admin',
              host: 'localhost',
              port: 5673
            })
            connection.open_sender('amq.topic')
            connection.open_receiver('amq.topic')
          })

          withNamingSchema(
            () => { context.sender.send({ body: 'Hello World!' }) },
            () => namingSchema.receive.opName, () => 'a_test_service'
          )

          it('should use the configuration for the receiver', (done) => {
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.have.property('name', namingSchema.receive.opName)
              expect(span).to.have.property('service', 'a_test_service')
            })
              .then(done, done)
            context.sender.send({ body: 'Hello World!' })
          })

          it('should use the configuration for the sender', (done) => {
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.have.property('name', namingSchema.send.opName)
              expect(span).to.have.property('service', 'a_test_service')
            })
              .then(done, done)
            context.sender.send({ body: 'Hello World!' })
          })
        })
      })

      describe('without broker', () => {
        let server
        let serverContext
        let client
        let clientContext
        let connection

        beforeEach(() => {
          tracer = require('../../dd-trace')
        })

        afterEach((done) => {
          if (connection.socket_ready) {
            connection.once('connection_close', () => done())
            connection.close()
          } else {
            done()
          }
        })

        describe('with defaults', () => {
          beforeEach(() => agent.reload('rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })

            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver('amq.topic.2')
              connection.open_sender('amq.topic.2')
            })
          })

          describe('client sent message', () => {
            it('should be instrumented on receiving', done => {
              const p = expectReceiving(agent, namingSchema)

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on sending', done => {
              const p = expectSending(agent, namingSchema, null, 'amq.topic.2')

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })
          })

          describe('server sent message', () => {
            it('should be instrumented on receiving', done => {
              const p = expectReceiving(agent, namingSchema, null, 'amq.topic.2')

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on sending', done => {
              const p = expectSending(agent, namingSchema)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            describe('exception in message handler', () => {
              it('should produce an error in span metadata', (done) => {
                const Session = require(`../../../versions/rhea@${version}/node_modules/rhea/lib/session.js`)
                const onTransfer = Session.prototype.on_transfer
                const error = new Error('this is an error')
                Session.prototype.on_transfer = function onTransferWrapped () {
                  try {
                    return onTransfer.apply(this, arguments)
                  } catch (e) {
                    // this is just to prevent mocha from crashing
                  }
                }

                client.on('message', () => {
                  throw error
                })

                agent.use(traces => {
                  const span = traces[0][0]
                  expect(span.error).to.equal(1)
                  expect(span.meta).to.include({
                    [ERROR_MESSAGE]: 'this is an error',
                    [ERROR_TYPE]: 'Error',
                    [ERROR_STACK]: error.stack,
                    'component': 'rhea'
                  })
                  Session.prototype.on_transfer = onTransfer
                }).then(done, done)

                serverContext.sender.send({ body: 'Hello World!' })
              })
            })
          })
        })

        describe('with pre-settled messages', () => {
          beforeEach(() => agent.reload('rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })

            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver()
              connection.open_sender({ snd_settle_mode: 1 })
            })
          })

          describe('client sent message', () => {
            it('should be instrumented on sending', done => {
              const p = expectSending(agent, namingSchema, false)

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving', done => {
              const p = expectReceiving(agent, namingSchema)

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })
          })

          describe('server sent message', () => {
            it('should be instrumented on sending', done => {
              const p = expectSending(agent, namingSchema)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving', done => {
              const p = expectReceiving(agent, namingSchema)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })
          })
        })

        describe('with manually settled messages', () => {
          beforeEach(() => agent.reload('rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            server.once('sendable', _context => {
              serverContext = _context
              done()
            })
            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver({ autoaccept: false })
            })
          })

          describe('server sent message', () => {
            it('should be instrumented on sending', done => {
              const p = expectSending(agent, namingSchema)

              client.on('message', msg => {
                msg.delivery.accept()
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving and accepting', done => {
              const p = expectReceiving(agent, namingSchema)

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.accept()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving and rejecting', done => {
              const p = expectReceiving(agent, namingSchema, 'rejected')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.reject()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving and releasing', done => {
              const p = expectReceiving(agent, namingSchema, 'released')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.release()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('should be instrumented on receiving and modifying', done => {
              const p = expectReceiving(agent, namingSchema, 'modified')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.modified()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })
          })
        })

        describe('on disconnect', () => {
          beforeEach(() => agent.reload('rhea'))

          let expectedServerPort

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })
            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(Object.assign({ reconnect: false }, listener.address()))
              connection.open_receiver({ autoaccept: false })
              connection.open_sender()
              expectedServerPort = listener.address().port
            })
          })

          it('sender span should get closed', (done) => {
            const err = new Error('fake protocol error')
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.include({
                name: namingSchema.send.opName,
                resource: 'amq.topic',
                error: 1,
                service: namingSchema.send.serviceName
              })
              expect(span.meta).to.include({
                'span.kind': 'producer',
                'amqp.link.target.address': 'amq.topic',
                'amqp.link.role': 'sender',
                [ERROR_TYPE]: 'Error',
                [ERROR_MESSAGE]: 'fake protocol error',
                [ERROR_STACK]: err.stack,
                'component': 'rhea'
              })
              expect(span.metrics).to.include({
                'network.destination.port': expectedServerPort
              })
            }).then(done, done)
            connection.output = function () {
              this.on('disconnected', () => {}) // prevent logging the error
              this.saved_error = err
              this.dispatch('protocol_error', err)
              this.socket.end()
            }
            clientContext.sender.send({ body: 'hello' })
          })

          it('receiver span should closed', (done) => {
            const err = new Error('fake protocol error')
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.include({
                name: namingSchema.receive.opName,
                resource: 'amq.topic',
                error: 1,
                service: namingSchema.receive.serviceName
              })
              expect(span.meta).to.include({
                'span.kind': 'consumer',
                'amqp.link.source.address': 'amq.topic',
                'amqp.link.role': 'receiver',
                [ERROR_TYPE]: 'Error',
                [ERROR_MESSAGE]: 'fake protocol error',
                [ERROR_STACK]: err.stack,
                'component': 'rhea'
              })
            }).then(done, done)
            client.on('message', msg => {
              connection.on('disconnected', () => {}) // prevent logging the error
              connection.saved_error = err
              connection.dispatch('protocol_error', err)
              connection.socket.end()
            })
            serverContext.sender.send({ body: 'hello' })
          })
        })
      })
    })
  })
})

function expectReceiving (agent, namingSchema, deliveryState, topic) {
  deliveryState = deliveryState || deliveryState === false ? undefined : 'accepted'
  topic = topic || 'amq.topic'
  return Promise.resolve().then(() => agent.use(traces => {
    const span = traces[0][0]
    expect(span).to.include({
      name: namingSchema.receive.opName,
      resource: topic,
      error: 0,
      service: namingSchema.receive.serviceName,
      type: 'worker'
    })
    const expectedMeta = {
      'span.kind': 'consumer',
      'amqp.link.source.address': topic,
      'amqp.link.role': 'receiver',
      'component': 'rhea'
    }
    if (deliveryState) {
      expectedMeta['amqp.delivery.state'] = deliveryState
    }
    expect(span.meta).to.include(expectedMeta)
  }))
}

function expectSending (agent, namingSchema, deliveryState, topic) {
  deliveryState = deliveryState || deliveryState === false ? undefined : 'accepted'
  topic = topic || 'amq.topic'
  return Promise.resolve().then(() => agent.use(traces => {
    const span = traces[0][0]
    expect(span).to.include({
      name: namingSchema.send.opName,
      resource: topic,
      error: 0,
      service: namingSchema.send.serviceName
    })
    expect(span).to.not.have.property('type')
    const expectedMeta = {
      'span.kind': 'producer',
      'amqp.link.target.address': topic,
      'amqp.link.role': 'sender',
      'component': 'rhea'
    }
    if (deliveryState) {
      expectedMeta['amqp.delivery.state'] = deliveryState
    }
    expect(span.meta).to.include(expectedMeta)
  }))
}
