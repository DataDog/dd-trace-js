'use strict'

const assert = require('node:assert')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

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
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'redis')
              expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
              expect(traces[0][0].metrics).to.have.property('network.destination.port', 6379)
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
            expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
            expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(traces[0][0].meta).to.have.property('component', 'redis')
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
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
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
              expect(span.context().active()).to.equal(span)
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
            expect(traces[0][0]).to.have.property('service', 'custom')
            expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            expect(traces[0][0].metrics).to.have.property('network.destination.port', 6379)
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
            expect(traces[0][0]).to.have.property('resource', 'GET')
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
            expect(traces[0][0]).to.have.property('resource', 'GET')
          })

          await client.set('turtle', 'like')
          await client.get('turtle')
          await promise
        })
      })
    })
  })
})
