'use strict'

const assert = require('node:assert')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
describe('Plugin', () => {
  describe('redis', () => {
    withVersions('redis', ['@node-redis/client', '@redis/client'], (version, moduleName) => {
      let redis
      let client
      let tracer
      describe('client basics', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
        })

        it('should support queue options', async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          const client = redis.createClient({ url: 'redis://127.0.0.1:6379', commandsQueueMaxLength: 1 })
          const connectPromise = client.connect()
          const passingPromise = client.get('foo')
          await assert.rejects(Promise.all([
            passingPromise,
            client.get('bar'),
            connectPromise,
          ]), {
            message: /queue/
          })
          await passingPromise
          await client.quit()
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient({ url: 'redis://127.0.0.1:6379' })

          await client.connect()
        })

        afterEach(async () => {
          unbreakThen(Promise.prototype)
          await client.quit()
        })

        it('should do automatic instrumentation when using callbacks', async () => {
          const promise = agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'GET')
              assert.strictEqual(traces[0][0].type, 'redis')
              assert.strictEqual(traces[0][0].meta['db.name'], '0')
              assert.strictEqual(traces[0][0].meta['db.type'], 'redis')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['redis.raw_command'], 'GET foo')
              assert.strictEqual(traces[0][0].meta.component, 'redis')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'redis')
              assert.strictEqual(traces[0][0].meta['out.host'], '127.0.0.1')
              assert.strictEqual(traces[0][0].metrics['network.destination.port'], 6379)
            })

          await client.get('foo')
          await promise
        })

        withPeerService(
          () => tracer,
          'redis',
          () => client.get('bar'),
          '127.0.0.1',
          'out.host'
        )

        it('should handle errors', async () => {
          let error

          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(traces[0][0].meta.component, 'redis')
            // stack trace is not available in newer versions
          })

          try {
            await client.sendCommand('invalid')
          } catch (e) {
            error = e
          }

          await promise
        })

        it('should work with userland promises', async () => {
          const promise = agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'GET')
              assert.strictEqual(traces[0][0].type, 'redis')
              assert.strictEqual(traces[0][0].meta['db.name'], '0')
              assert.strictEqual(traces[0][0].meta['db.type'], 'redis')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['redis.raw_command'], 'GET foo')
              assert.strictEqual(traces[0][0].meta.component, 'redis')
            })

          breakThen(Promise.prototype)

          await client.get('foo')
          await promise
        })

        withNamingSchema(
          async () => client.get('foo'),
          rawExpectedSchema.outbound
        )

        it('should restore the parent context in the callback', async () => {
          const span = {}
          tracer.scope().activate(span, () => {
            client.get('foo', () => {
              assert.strictEqual(span.context().active(), span)
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            allowlist: ['GET']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
          await client.quit()
        })

        it('should be configured with the correct values', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
            assert.strictEqual(traces[0][0].metrics['network.destination.port'], 6379)
          })

          await client.get('foo')
          await promise
        })

        withPeerService(
          () => tracer,
          'redis',
          () => client.get('bar'),
          'localhost', 'out.host')

        it('should be able to filter commands', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'GET')
          })

          await client.get('foo')
          await promise
        })

        withNamingSchema(
          async () => client.get('foo'),
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

      describe('with blocklist', () => {
        before(() => {
          return agent.load('redis', {
            blocklist: [
              'Set', // this should block set and SET commands
              'FOO'
            ]
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
          await client.quit()
        })

        it('should be able to filter commands on a case-insensitive basis', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'GET')
          })

          await client.set('turtle', 'like')
          await client.get('turtle')
          await promise
        })
      })
    })
  })
})
