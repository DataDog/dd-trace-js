'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
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
            (done) => {
              sender.send({ key: 'value' })
              done()
            },
            'localhost',
            'out.host'
          )

          it('should do automatic instrumentation', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]

                assert.strictEqual(span.name, expectedSchema.send.opName)
                assert.strictEqual(span.service, expectedSchema.send.serviceName)
                assert.strictEqual(span.resource, 'send amq.topic')
                assert.ok(!Object.hasOwn(span, 'type'))
                assert.strictEqual(span.meta['span.kind'], 'producer')
                assert.strictEqual(span.meta['out.host'], 'localhost')
                assert.strictEqual(span.meta['amqp.connection.host'], 'localhost')
                assert.strictEqual(span.meta['amqp.connection.user'], 'admin')
                assert.strictEqual(span.meta['amqp.link.target.address'], 'amq.topic')
                assert.strictEqual(span.meta['amqp.link.role'], 'sender')
                assert.match(span.meta['amqp.link.name'], /^amq\.topic_[0-9a-f-]+$/)
                assert.strictEqual(span.meta.component, 'amqp10')
                assert.strictEqual(span.meta['_dd.integration'], 'amqp10')
                assert.strictEqual(span.metrics['network.destination.port'], 5673)
                assert.strictEqual(span.metrics['amqp.connection.port'], 5673)
                assert.strictEqual(span.metrics['amqp.link.handle'], 1)
              })
              .then(done)
              .catch(done)

            sender.send({ key: 'value' })
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
                assert.strictEqual(span.meta.component, 'amqp10')
              })
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
              assert.ok(!Object.hasOwn(promise, 'value') && ('value' in promise))
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
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                assert.strictEqual(span.name, expectedSchema.receive.opName)
                assert.strictEqual(span.service, expectedSchema.receive.serviceName)
                assert.strictEqual(span.resource, 'receive amq.topic')
                assert.strictEqual(span.type, 'worker')
                assert.strictEqual(span.meta['span.kind'], 'consumer')
                assert.strictEqual(span.meta['amqp.connection.host'], 'localhost')
                assert.strictEqual(span.meta['amqp.connection.user'], 'admin')
                assert.strictEqual(span.meta['amqp.link.source.address'], 'amq.topic')
                assert.strictEqual(span.meta['amqp.link.role'], 'receiver')
                assert.match(span.meta['amqp.link.name'], /^amq\.topic_[0-9a-f-]+$/)
                assert.strictEqual(span.meta.component, 'amqp10')
                assert.strictEqual(span.metrics['amqp.connection.port'], 5673)
                assert.strictEqual(span.metrics['amqp.link.handle'], 0)
              })
              .then(done)
              .catch(done)

            sender.send({ key: 'value' })
          })

          it('should run the message event listener in the AMQP span scope', done => {
            tracer.scope().activate(null, () => {
              receiver.on('message', message => {
                const span = tracer.scope().active()

                assert.notStrictEqual(span, null)

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
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.service, 'test-custom-name')
            })
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
