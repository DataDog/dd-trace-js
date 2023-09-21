'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let tracer
  let client
  let receiver
  let sender
  let callbackPolicy

  describe('amqp10', () => {
    before(() => agent.load('rhea'))
    after(() => agent.close({ ritmReset: false }))

    withVersions('amqp10', 'amqp10', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        return Promise.all([
          receiver && receiver.detach(),
          sender && sender.detach()
        ])
      })

      afterEach(() => client.disconnect())

      describe('without configuration', () => {
        beforeEach(() => {
          agent.reload('amqp10')

          const amqp = require(`../../../versions/amqp10@${version}`).get()
          const None = amqp.Policy.Utils.SenderCallbackPolicies.None
          const OnSettle = amqp.Policy.Utils.SenderCallbackPolicies.OnSettle

          callbackPolicy = None || OnSettle

          client = new amqp.Client(amqp.Policy.merge({
            senderLink: {
              callback: callbackPolicy
            }
          }))

          return client.connect('amqp://admin:admin@localhost:5673')
            .then(() => {
              return Promise.all([
                client.createReceiver('amq.topic'),
                client.createSender('amq.topic')
              ])
            })
            .then(handlers => {
              receiver = handlers[0]
              sender = handlers[1]
            })
        })

        describe('when sending messages', () => {
          withPeerService(
            () => tracer,
            'amqp10',
            () => sender.send({ key: 'value' }),
            'localhost',
            'out.host'
          )

          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const span = traces[0][0]

                expect(span).to.have.property('name', expectedSchema.send.opName)
                expect(span).to.have.property('service', expectedSchema.send.serviceName)
                expect(span).to.have.property('resource', 'send amq.topic')
                expect(span).to.not.have.property('type')
                expect(span.meta).to.have.property('span.kind', 'producer')
                expect(span.meta).to.have.property('out.host', 'localhost')
                expect(span.meta).to.have.property('amqp.connection.host', 'localhost')
                expect(span.meta).to.have.property('amqp.connection.user', 'admin')
                expect(span.meta).to.have.property('amqp.link.target.address', 'amq.topic')
                expect(span.meta).to.have.property('amqp.link.role', 'sender')
                expect(span.meta['amqp.link.name']).to.match(/^amq\.topic_[0-9a-f-]+$/)
                expect(span.meta).to.have.property('component', 'amqp10')
                expect(span.metrics).to.have.property('network.destination.port', 5673)
                expect(span.metrics).to.have.property('amqp.connection.port', 5673)
                expect(span.metrics).to.have.property('amqp.link.handle', 1)
              }, 2)
              .then(done)
              .catch(done)

            sender.send({ key: 'value' })
          })
          it('should handle errors', done => {
            let error

            agent
              .use(traces => {
                const span = traces[0][0]

                expect(span.error).to.equal(1)
                expect(span.meta).to.have.property(ERROR_TYPE, error.name)
                expect(span.meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(span.meta).to.have.property(ERROR_STACK, error.stack)
                expect(span.meta).to.have.property('component', 'amqp10')
              }, 2)
              .then(done)
              .catch(done)

            if (callbackPolicy === 'none') {
              try {
                sender.send(() => {})
              } catch (e) {
                error = e
              }
            } else {
              sender.send(() => {}).catch(err => {
                error = err
              })
            }
          })

          it('should not override the returned promise', () => {
            if (callbackPolicy === 'none') return

            const promise = sender.send({ key: 'value' })

            return promise.then(() => {
              expect(promise).to.have.property('value')
            })
          })

          withNamingSchema(
            () => sender.send({ key: 'value' }),
            rawExpectedSchema.send
          )
        })

        describe('when consuming messages', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.receive.opName)
                expect(span).to.have.property('service', expectedSchema.receive.serviceName)
                expect(span).to.have.property('resource', 'receive amq.topic')
                expect(span).to.have.property('type', 'worker')
                expect(span.meta).to.have.property('span.kind', 'consumer')
                expect(span.meta).to.have.property('amqp.connection.host', 'localhost')
                expect(span.meta).to.have.property('amqp.connection.user', 'admin')
                expect(span.meta).to.have.property('amqp.link.source.address', 'amq.topic')
                expect(span.meta).to.have.property('amqp.link.role', 'receiver')
                expect(span.meta['amqp.link.name']).to.match(/^amq\.topic_[0-9a-f-]+$/)
                expect(span.meta).to.have.property('component', 'amqp10')
                expect(span.metrics).to.have.property('amqp.connection.port', 5673)
                expect(span.metrics).to.have.property('amqp.link.handle', 0)
              }, 2)
              .then(done)
              .catch(done)

            sender.send({ key: 'value' })
          })

          it('should run the message event listener in the AMQP span scope', done => {
            tracer.scope().activate(null, () => {
              receiver.on('message', message => {
                const span = tracer.scope().active()

                expect(span).to.not.be.null

                done()
              })
            })

            sender.send({ key: 'value' })
          })

          withNamingSchema(
            () => sender.send({ key: 'value' }),
            rawExpectedSchema.receive
          )
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          agent.reload('amqp10', { service: 'test-custom-name' })

          const amqp = require(`../../../versions/amqp10@${version}`).get()

          client = new amqp.Client()

          return client.connect('amqp://admin:admin@localhost:5673')
            .then(() => {
              return Promise.all([
                client.createReceiver('amq.topic'),
                client.createSender('amq.topic')
              ])
            })
            .then(handlers => {
              receiver = handlers[0]
              sender = handlers[1]
            })
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('service', 'test-custom-name')
            }, 2)
            .then(done)
            .catch(done)

          sender.send({ key: 'value' })
        })

        withNamingSchema(
          () => sender.send({ key: 'value' }),
          {
            v0: {
              opName: 'amqp.receive',
              serviceName: 'test-custom-name'
            },
            v1: {
              opName: 'amqp.process',
              serviceName: 'test-custom-name'
            }
          }
        )
      })
    })
  })
})
