'use strict'

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let Valkey
  let valkey
  let tracer

  describe('iovalkey', () => {
    withVersions('iovalkey', 'iovalkey', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Valkey = require(`../../../versions/iovalkey@${version}`).get()
        valkey = new Valkey({ connectionName: 'test' })
      })

      afterEach(() => {
        unbreakThen(Promise.prototype)
        valkey.quit()
      })

      describe('without configuration', () => {
        beforeEach(() => agent.load(['iovalkey']))

        afterEach(() => agent.close({ ritmReset: false }))

        it('should do automatic instrumentation when using callbacks', async () => {
          agent.assertSomeTraces(() => {}) // wait for initial info command
          const promise = agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(traces[0][0]).to.have.property('resource', 'get')
            expect(traces[0][0]).to.have.property('type', 'valkey')
            expect(traces[0][0].meta).to.have.property('component', 'iovalkey')
            expect(traces[0][0].meta).to.have.property('db.name', '0')
            expect(traces[0][0].meta).to.have.property('db.type', 'valkey')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            expect(traces[0][0].meta).to.have.property('valkey.raw_command', 'GET foo')
            expect(traces[0][0].metrics).to.have.property('network.destination.port', 6379)
          })

          await Promise.all([
            valkey.get('foo'),
            promise
          ])
        })

        it('should run the callback in the parent context', () => {
          const span = {}

          return tracer.scope().activate(span, async () => {
            await valkey.get('foo')
            expect(tracer.scope().active()).to.equal(span)
          })
        })

        it('should handle errors', done => {
          let error

          agent.assertSomeTraces(() => {}) // wait for initial info command
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'iovalkey')
            })
            .then(done)
            .catch(done)

          valkey.set('foo', 123, 'bar')
            .catch(err => {
              error = err
            })
        })

        it('should work with userland promises', done => {
          agent.assertSomeTraces(() => {}) // wait for initial info command
          agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(traces[0][0]).to.have.property('resource', 'get')
            expect(traces[0][0]).to.have.property('type', 'valkey')
            expect(traces[0][0].meta).to.have.property('db.name', '0')
            expect(traces[0][0].meta).to.have.property('db.type', 'valkey')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            expect(traces[0][0].meta).to.have.property('valkey.raw_command', 'GET foo')
            expect(traces[0][0].meta).to.have.property('component', 'iovalkey')
            expect(traces[0][0].metrics).to.have.property('network.destination.port', 6379)
          })
            .then(done)
            .catch(done)

          breakThen(Promise.prototype)

          valkey.get('foo').catch(done)
        })

        withNamingSchema(
          done => valkey.get('foo').catch(done),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        before(() => agent.load('iovalkey', {
          service: 'custom',
          splitByInstance: true,
          allowlist: ['get']
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom-test')
            })
            .then(done)
            .catch(done)

          valkey.get('foo').catch(done)
        })

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          valkey.get('foo').catch(done)
        })

        withNamingSchema(
          done => valkey.get('foo').catch(done),
          {
            v0: {
              opName: 'valkey.command',
              serviceName: 'custom-test'
            },
            v1: {
              opName: 'valkey.command',
              serviceName: 'custom'
            }
          }
        )
      })

      describe('with legacy configuration', () => {
        before(() => agent.load('iovalkey', {
          whitelist: ['get']
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          valkey.get('foo').catch(done)
        })
      })
    })
  })
})
