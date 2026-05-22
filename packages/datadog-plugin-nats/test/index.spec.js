'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// Pulls messages from an async iterator subscription, returning all received.
async function drainAll (sub) {
  const messages = []
  for await (const msg of sub) {
    messages.push(msg)
  }
  return messages
}

describe('Plugin', () => {
  let tracer
  let connect
  let connection
  let subject

  describe('nats', () => {
    withVersions('nats', '@nats-io/transport-node', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        subject = `test-${id()}`
        connect = require(`../../../versions/@nats-io/transport-node@${version}`).get().connect
      })

      afterEach(async () => {
        if (connection && !connection.isClosed()) {
          await connection.drain().catch(() => {})
          await connection.close().catch(() => {})
        }
        connection = null
      })

      describe('without configuration', () => {
        beforeEach(async () => {
          await agent.load('nats')
          connection = await connect({ servers: '127.0.0.1:4222' })
        })

        afterEach(() => agent.close({ ritmReset: false }))

        it('should run commands normally without a plugin loaded', async () => {
          // Sanity: published message must round-trip even when only producer spans matter.
          const received = new Promise(resolve => {
            connection.subscribe(subject, {
              max: 1,
              callback: (_err, msg) => resolve(msg),
            })
          })
          connection.publish(subject, 'hello')
          const msg = await received
          assert.ok(msg, `expected to receive a message on ${subject}`)
        })

        describe('publish', () => {
          withPeerService(
            () => tracer,
            'nats',
            (done) => {
              connection.publish(subject, 'hello')
              done()
            },
            () => subject,
            'messaging.destination.name'
          )

          it('creates a producer span for publish', () => {
            const assertion = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              assertObjectContains(span, {
                name: expectedSchema.send.opName,
                service: expectedSchema.send.serviceName,
                resource: subject,
                meta: {
                  component: 'nats',
                  'span.kind': 'producer',
                  'nats.subject': subject,
                  'nats.operation': 'publish',
                  'messaging.destination.name': subject,
                  '_dd.integration': 'nats',
                },
              })
            })

            connection.publish(subject, 'hello')
            return assertion
          })

          withNamingSchema(
            () => connection.publish(subject, 'hello'),
            rawExpectedSchema.send
          )
        })

        describe('request', () => {
          it('creates a producer span for request', () => {
            const responder = connection.subscribe(subject, {
              max: 1,
              callback: (_err, msg) => msg.respond('pong'),
            })
            void responder

            const assertion = agent.assertSomeTraces(traces => {
              const producer = traces[0].find(s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'producer')
              assert.ok(producer, 'expected producer span')
              assertObjectContains(producer, {
                name: expectedSchema.send.opName,
                service: expectedSchema.send.serviceName,
                resource: subject,
                meta: {
                  component: 'nats',
                  'nats.subject': subject,
                  'nats.operation': 'request',
                },
              })
            })

            return Promise.all([
              connection.request(subject, 'ping', { timeout: 2000 }),
              assertion,
            ])
          })
        })

        describe('subscribe (callback)', () => {
          it('creates a consumer span for delivered messages', async () => {
            const received = new Promise(resolve => {
              connection.subscribe(subject, {
                max: 1,
                callback: (_err, msg) => resolve(msg),
              })
            })

            const assertion = agent.assertSomeTraces(traces => {
              const consumer = traces[0].find(s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'consumer')
              assert.ok(consumer, 'expected consumer span')
              assertObjectContains(consumer, {
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                resource: subject,
                type: 'worker',
                meta: {
                  component: 'nats',
                  'nats.subject': subject,
                  'messaging.destination.name': subject,
                },
              })
            })

            connection.publish(subject, 'hello')
            await received
            return assertion
          })

          withNamingSchema(
            () => new Promise(resolve => {
              connection.subscribe(subject, {
                max: 1,
                callback: () => resolve(),
              })
              connection.publish(subject, 'hello')
            }),
            rawExpectedSchema.receive
          )
        })

        describe('subscribe (iterator)', () => {
          it('creates a consumer span per yielded message', async () => {
            const sub = connection.subscribe(subject, { max: 1 })

            const assertion = agent.assertSomeTraces(traces => {
              const consumer = traces[0].find(s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'consumer')
              assert.ok(consumer, 'expected consumer span')
              assertObjectContains(consumer, {
                resource: subject,
                meta: { component: 'nats', 'nats.subject': subject },
              })
            })

            const receive = drainAll(sub)

            connection.publish(subject, 'hello')
            await receive
            return assertion
          })
        })

        describe('distributed tracing', () => {
          it('propagates trace context via headers', async () => {
            const received = new Promise(resolve => {
              connection.subscribe(subject, {
                max: 1,
                callback: (_err, msg) => resolve(msg),
              })
            })

            const assertion = agent.assertSomeTraces(traces => {
              const consumer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'consumer'
              )
              assert.ok(consumer, 'expected consumer span')
              const parentId = consumer.parent_id?.toString?.()
              assert.ok(parentId && parentId !== '0', `expected non-zero parent_id, got ${parentId}`)
            })

            connection.publish(subject, 'hello')
            await received
            return assertion
          })
        })
      })
    })
  })
})
