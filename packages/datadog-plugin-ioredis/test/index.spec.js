'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let Redis
  let redis
  let tracer

  describe('ioredis', () => {
    withVersions('ioredis', 'ioredis', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Redis = require(`../../../versions/ioredis@${version}`).get()
        redis = new Redis({ connectionName: 'test' })
      })

      afterEach(() => {
        unbreakThen(Promise.prototype)
        redis.quit()
      })

      describe('without configuration', () => {
        beforeEach(() => agent.load(['ioredis']))

        afterEach(() => agent.close({ ritmReset: false }))

        it('should do automatic instrumentation when using callbacks', async () => {
          await redis.get('foo')

          await agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('name', expectedSchema.outbound.opName)
            expect(trace).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(trace).to.have.property('resource', 'get')
            expect(trace).to.have.property('type', 'redis')
            expect(trace.meta).to.have.property('component', 'ioredis')
            expect(trace.meta).to.have.property('db.name', '0')
            expect(trace.meta).to.have.property('db.type', 'redis')
            expect(trace.meta).to.have.property('span.kind', 'client')
            expect(trace.meta).to.have.property('out.host', 'localhost')
            expect(trace.meta).to.have.property('redis.raw_command', 'GET foo')
            expect(trace.metrics).to.have.property('network.destination.port', 6379)
          })
        })

        it('should run the callback in the parent context', () => {
          const span = {}

          return tracer.scope().activate(span, async () => {
            await redis.get('foo')
            expect(tracer.scope().active()).to.equal(span)
          })
        })

        it('should handle errors', async () => {
          let error

          try {
            await redis.set('foo', 123, 'bar')
          } catch (err) {
            error = err
          }

          await agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('error', 1)
            expect(trace.meta).to.have.property(ERROR_TYPE, error.name)
            expect(trace.meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(trace.meta).to.have.property(ERROR_STACK, error.stack)
            expect(trace.meta).to.have.property('component', 'ioredis')
          })
        })

        it('should work with userland promises', async () => {
          breakThen(Promise.prototype)

          await redis.get('foo')

          await agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('name', expectedSchema.outbound.opName)
            expect(trace).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(trace).to.have.property('resource', 'get')
            expect(trace).to.have.property('type', 'redis')
            expect(trace.meta).to.have.property('db.name', '0')
            expect(trace.meta).to.have.property('db.type', 'redis')
            expect(trace.meta).to.have.property('span.kind', 'client')
            expect(trace.meta).to.have.property('out.host', 'localhost')
            expect(trace.meta).to.have.property('redis.raw_command', 'GET foo')
            expect(trace.meta).to.have.property('component', 'ioredis')
            expect(trace.metrics).to.have.property('network.destination.port', 6379)
          })
        })

        withNamingSchema(
          done => redis.get('foo').catch(done),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        before(() => agent.load('ioredis', {
          service: 'custom',
          splitByInstance: true,
          allowlist: ['get']
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be configured with the correct values', async () => {
          await redis.get('foo')

          agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('service', 'custom-test')
          })
        })

        it('should be able to filter commands', async () => {
          await redis.get('foo')

          await agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('resource', 'get')
          })
        })

        withNamingSchema(
          done => redis.get('foo').catch(done),
          {
            v0: {
              opName: 'redis.command',
              serviceName: 'custom-test'
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom'
            }
          }
        )
      })

      describe('with legacy configuration', () => {
        before(() => agent.load('ioredis', {
          whitelist: ['get']
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be able to filter commands', async () => {
          await redis.get('foo')

          await agent.assertFirstTrace(trace => {
            expect(trace).to.have.property('resource', 'get')
          })
        })
      })
    })
  })
})
