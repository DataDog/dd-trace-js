'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
describe('Legacy Plugin', () => {
  let redis
  let tracer
  let client
  let pub
  let sub

  describe('redis', () => {
    withVersions('redis', 'redis', '<4', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        client.quit(() => {})
        pub.quit(() => {})
        sub.quit(() => {})
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
          pub = redis.createClient()
          sub = redis.createClient()
        })

        withPeerService(
          () => tracer,
          'redis',
          (done) => client.get('foo', done),
          '127.0.0.1',
          'out.host'
        )

        it('should do automatic instrumentation when using callbacks', done => {
          client.on('error', done)
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'get')
              assert.strictEqual(traces[0][0].type, 'redis')
              assert.strictEqual(traces[0][0].meta['db.name'], '0')
              assert.strictEqual(traces[0][0].meta['db.type'], 'redis')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['out.host'], '127.0.0.1')
              assert.strictEqual(traces[0][0].meta['redis.raw_command'], 'GET foo')
              assert.strictEqual(traces[0][0].meta.component, 'redis')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'redis')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })

        it('should support commands without a callback', done => {
          sub.on('error', done)
          sub.on('message', () => done())
          sub.subscribe('foo')

          sub.on('subscribe', () => {
            pub.on('error', done)
            pub.publish('foo', 'test')
          })
        })

        it('should run the callback in the parent context', done => {
          client.on('error', done)

          client.get('foo', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should run client emitter listeners in the parent context', done => {
          client.on('error', done)

          client.on('ready', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should run stream emitter listeners in the parent context', done => {
          client.on('error', done)

          client.stream.on('close', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })

          client.stream.destroy()
        })

        // TODO: This test is flakey. I've seen it affect 2.6.0, 2.5.3, 3.1.2, 0.12.0
        // Increasing the test timeout does not help.
        // Error will be set but span will not.
        // agent.assertSomeTraces is called a dozen times per test in legacy.spec but once per test in client.spec
        it.skip('should handle errors', done => {
          const assertError = () => {
            if (!error || !span) return

            try {
              assert.strictEqual(span.meta[ERROR_TYPE], error.name)
              assert.strictEqual(span.meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(span.meta[ERROR_STACK], error.stack)
              assert.strictEqual(span.meta.component, 'redis')
              assert.strictEqual(span.metrics['network.destination.port'], 6379)
              done()
            } catch (e) {
              done(e)
            }
          }

          let error
          let span

          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'set')
            span = traces[0][0]
            assertError()
          })

          client.on('error', done)

          client.set('foo', 123, 'bar', (err, res) => {
            error = err
            assertError()
          })
        })

        withNamingSchema(
          () => client.get('foo', () => {}),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            allowlist: ['get']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
        })

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'custom')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
          client.on('error', done)
        })

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, 'get')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })

        withNamingSchema(
          () => client.get('foo', () => {}),
          {
            v0: {
              opName: 'redis.command',
              serviceName: 'custom'
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom'
            }
          }
        )
      })

      describe('with legacy configuration', () => {
        before(() => {
          return agent.load('redis', {
            whitelist: ['get']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
        })

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, 'get')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })
      })
    })
  })
})
