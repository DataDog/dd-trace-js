'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')
const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
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
          // close() may hang if a subscription callback threw (the library's drain
          // path waits for inflight messages); race with a timer to keep tests fast.
          await Promise.race([
            connection.close().catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 500)),
          ])
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

        describe('request span deduplication', () => {
          it('creates exactly one producer span per request (no nested publish span)', async () => {
            // request() internally calls this.publish() which is also wrapped.
            // Without suppression that would double-count every traced request.
            const responder = connection.subscribe(subject, {
              max: 1,
              callback: (_e, msg) => msg.respond('pong'),
            })
            void responder

            const assertion = agent.assertSomeTraces(traces => {
              const producers = traces[0].filter(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'producer'
              )
              assert.strictEqual(producers.length, 1,
                `expected exactly one producer span for the request, got ${producers.length}`)
              assert.strictEqual(producers[0].meta['nats.operation'], 'request')
            })

            await connection.request(subject, 'ping', { timeout: 2000 })
            await assertion
          })
        })

        describe('publishMessage', () => {
          it('creates a producer span via the wrapped prototype publish', () => {
            const assertion = agent.assertSomeTraces(traces => {
              const producer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'producer'
              )
              assert.ok(producer, 'expected producer span')
              assertObjectContains(producer, {
                resource: subject,
                meta: { 'nats.subject': subject, 'nats.operation': 'publish' },
              })
            })

            connection.publishMessage({ subject, data: 'hello' })
            return assertion
          })
        })

        describe('respondMessage', () => {
          it('creates a producer span when replying to a Msg', async () => {
            const replyInbox = `reply-${id()}`
            const received = new Promise(resolve => {
              connection.subscribe(replyInbox, {
                max: 1,
                callback: (_e, msg) => resolve(msg),
              })
            })

            const assertion = agent.assertSomeTraces(traces => {
              const producer = traces[0].find(
                s =>
                  s.meta?.component === 'nats' &&
                  s.meta['span.kind'] === 'producer' &&
                  s.resource === replyInbox
              )
              assert.ok(producer, 'expected producer span for the reply')
            })

            // respondMessage internally calls this.publish(msg.reply, ...) which
            // hits the wrapped prototype method.
            connection.respondMessage({ subject, reply: replyInbox, data: 'pong' })
            await received
            return assertion
          })
        })

        describe('wildcard subscriptions', () => {
          it('uses the delivered subject, not the subscription filter', async () => {
            const wildcard = `${subject}.*`
            const concrete = `${subject}.created`
            const received = new Promise(resolve => {
              connection.subscribe(wildcard, {
                max: 1,
                callback: (_e, msg) => resolve(msg),
              })
            })

            const assertion = agent.assertSomeTraces(traces => {
              const consumer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'consumer'
              )
              assert.ok(consumer, 'expected consumer span')
              assertObjectContains(consumer, {
                resource: concrete,
                meta: {
                  'nats.subject': concrete,
                  'messaging.destination.name': concrete,
                  'nats.subscription.subject': wildcard,
                },
              })
            })

            connection.publish(concrete, 'hello')
            await received
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

        describe('errors', () => {
          it('records sync publish failures and rethrows', () => {
            const assertion = agent.assertSomeTraces(traces => {
              const producer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'producer'
              )
              assert.ok(producer, 'expected producer span')
              assert.strictEqual(producer.error, 1)
              assert.ok(producer.meta?.[ERROR_MESSAGE], 'expected an error message tag')
            })

            // Empty subject — nats-core's `_check()` throws synchronously,
            // exercising the catch/publishErrorCh branch in `wrapSyncProducer`.
            assert.throws(() => connection.publish('', 'hello'))
            return assertion
          })

          it('records async request failures and rejects', async () => {
            const assertion = agent.assertSomeTraces(traces => {
              const producer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'producer'
              )
              assert.ok(producer, 'expected producer span')
              assert.strictEqual(producer.error, 1)
            })

            // No responder is subscribed — the broker returns a 503 NoResponders
            // status after the configured timeout, hitting the async rejection branch.
            await assert.rejects(connection.request(subject, 'hello', { timeout: 200 }))
            await assertion
          })

          it('records consumer callback errors and rethrows', async () => {
            const fakeError = new Error('boom')

            const assertion = agent.assertSomeTraces(traces => {
              const consumer = traces[0].find(
                s => s.meta?.component === 'nats' && s.meta['span.kind'] === 'consumer'
              )
              assert.ok(consumer, 'expected consumer span')
              assert.strictEqual(consumer.error, 1)
              assert.strictEqual(consumer.meta?.[ERROR_MESSAGE], fakeError.message)
            })

            connection.subscribe(subject, {
              max: 1,
              callback: () => { throw fakeError },
            })
            connection.publish(subject, 'hello')
            await assertion
          })

          it('passes through null/error deliveries without creating a span', () => {
            // NATS calls the user's callback with `(err, {})` on subscription timeout —
            // exercises the `!message || err` short-circuit before the runStores branch.
            let called = false
            connection.subscribe(subject, {
              max: 1,
              timeout: 50,
              callback: (err) => { called = true; assert.ok(err) },
            })
            return new Promise(resolve => setTimeout(() => { assert.ok(called); resolve() }, 200))
          })
        })
      })

      describe('when the plugin is disabled', () => {
        beforeEach(async () => {
          await agent.load('nats', { enabled: false })
          connection = await connect({ servers: '127.0.0.1:4222' })
        })

        afterEach(() => agent.close({ ritmReset: false }))

        it('skips the publish wrapper fast-path', () => {
          // The wrap's `!hasSubscribers` branch returns the original immediately,
          // covering the early-out line in `wrapSyncProducer`/`wrapAsyncProducer`/subscribe.
          connection.publish(subject, 'hello')
        })

        it('skips the subscribe wrapper fast-path', () => {
          const sub = connection.subscribe(subject, { max: 1 })
          assert.ok(sub, 'expected subscription object')
          sub.unsubscribe()
        })

        it('skips the async-producer wrapper fast-path', async () => {
          // No responder — `request` will reject with timeout; the fast-path returns
          // the original promise without instrumenting it.
          await assert.rejects(connection.request(subject, 'hi', { timeout: 50 }))
        })
      })
    })
  })
})
