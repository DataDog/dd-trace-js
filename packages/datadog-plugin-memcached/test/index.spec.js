'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let Memcached
  let memcached
  let tracer

  describe('memcached', () => {
    withVersions('memcached', 'memcached', version => {
      afterEach(() => {
        memcached.end()
        agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(async () => {
          await agent.load('memcached')
          tracer = require('../../dd-trace')
          Memcached = proxyquire(`../../../versions/memcached@${version}/node_modules/memcached`, {})
        })

        withPeerService(
          () => tracer,
          'memcached',
          done => memcached.get('test', done),
          'localhost',
          'out.host'
        )

        it('should do automatic instrumentation when using callbacks', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'get',
              type: 'memcached',
              meta: {
                'span.kind': 'client',
                'out.host': 'localhost',
                'network.destination.port': '11211',
                component: 'memcached'
              }
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should run the callback in the parent context', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          const span = tracer.startSpan('web.request')

          tracer.scope().activate(span, () => {
            memcached.get('test', err => {
              if (err) return done(err)
              try {
                expect(tracer.scope().active()).to.equal(span)
                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        it('should handle errors', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          let error

          agent
            .assertFirstTraceSpan((trace) => {
              assertObjectContains(trace, {
                error: 1,
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'memcached'
                }
              })
            })
            .then(done)
            .catch(done)

          memcached.touch('test', 'invalid', err => {
            error = err
          })
        })

        it('should support an array of servers', done => {
          memcached = new Memcached(['localhost:11211'], { retries: 0 })

          agent
            .assertFirstTraceSpan({
              meta: {
                'out.host': 'localhost',
                'network.destination.port': '11211',
                component: 'memcached'
              }
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should support an object of servers with weights', done => {
          memcached = new Memcached({
            'localhost:11211': 1,
            'other:11211': 1
          }, { retries: 0 })

          agent
            .assertFirstTraceSpan({
              meta: {
                'out.host': 'localhost',
                'network.destination.port': '11211',
                component: 'memcached'
              }
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should support redundancy', done => {
          memcached = new Memcached({
            'localhost:11211': 1,
            'other:11211': 1
          }, {
            retries: 0,
            redundancy: 1
          })

          try {
            memcached.del('test', err => err && done(err))

            agent
              .assertFirstTraceSpan({
                meta: {
                  'out.host': 'localhost',
                  'network.destination.port': '11211',
                  component: 'memcached'
                }
              })
              .then(done)
              .catch(done)
          } catch (e) {
            // Bug in memcached will throw. Skip test when this happens.
            done()
          }
        })

        withNamingSchema(
          done => memcached.get('test', err => err && done(err)),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        beforeEach(async () => {
          await agent.load('memcached', { service: 'custom' })
          Memcached = proxyquire(`../../../versions/memcached@${version}/node_modules/memcached`, {})
          memcached = new Memcached('localhost:11211', { retries: 0 })
        })

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              service: 'custom'
            })
            .then(done)
            .catch(done)

          memcached.version(err => err && done(err))
        })
      })

      describe('when changing env vars', () => {
        describe('enabling command', () => {
          beforeEach(async () => {
            process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED = 'true'
            tracer._initialized = false // force config read
            await agent.load('memcached', { service: 'custom' })
            Memcached = proxyquire(`../../../versions/memcached@${version}/node_modules/memcached`, {})
            memcached = new Memcached('localhost:11211', { retries: 0 })
          })

          afterEach(() => {
            delete process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED
          })

          it('trace should contain memcached.command', done => {
            agent
              .assertFirstTraceSpan({
                meta: {
                  'memcached.command': 'version'
                }
              })
              .then(done)
              .catch(done)

            memcached.version(err => err && done(err))
          })
        })

        describe('disabling command', () => {
          beforeEach(async () => {
            process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED = 'false'
            tracer._initialized = false // force config read
            await agent.load('memcached', { service: 'custom' })
            Memcached = proxyquire(`../../../versions/memcached@${version}/node_modules/memcached`, {})
            memcached = new Memcached('localhost:11211', { retries: 0 })
          })

          afterEach(() => {
            delete process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED
          })

          it('trace should not contain memcached.command', done => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.not.have.property('memcached.command')
              })
              .then(done)
              .catch(done)

            memcached.version(err => err && done(err))
          })
        })
      })
    })
  })
})
