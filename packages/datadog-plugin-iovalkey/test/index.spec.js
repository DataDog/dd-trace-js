'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
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
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
            assert.strictEqual(traces[0][0].resource, 'get')
            assert.strictEqual(traces[0][0].type, 'valkey')
            assert.strictEqual(traces[0][0].meta.component, 'iovalkey')
            assert.strictEqual(traces[0][0].meta['_dd.integration'], 'iovalkey')
            assert.strictEqual(traces[0][0].meta['db.name'], '0')
            assert.strictEqual(traces[0][0].meta['db.type'], 'valkey')
            assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
            assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
            assert.strictEqual(traces[0][0].meta['valkey.raw_command'], 'GET foo')
            assert.strictEqual(traces[0][0].metrics['network.destination.port'], 6379)
          })

          await Promise.all([
            valkey.get('foo'),
            promise,
          ])
        })

        it('should run the callback in the parent context', () => {
          const span = {}

          return tracer.scope().activate(span, async () => {
            await valkey.get('foo')
            assert.strictEqual(tracer.scope().active(), span)
          })
        })

        it('should handle errors', done => {
          let error

          agent.assertSomeTraces(() => {}) // wait for initial info command
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][0].meta.component, 'iovalkey')
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
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
            assert.strictEqual(traces[0][0].resource, 'get')
            assert.strictEqual(traces[0][0].type, 'valkey')
            assert.strictEqual(traces[0][0].meta['db.name'], '0')
            assert.strictEqual(traces[0][0].meta['db.type'], 'valkey')
            assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
            assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
            assert.strictEqual(traces[0][0].meta['valkey.raw_command'], 'GET foo')
            assert.strictEqual(traces[0][0].meta.component, 'iovalkey')
            assert.strictEqual(traces[0][0].metrics['network.destination.port'], 6379)
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
          allowlist: ['get'],
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'custom-test')
            })
            .then(done)
            .catch(done)

          valkey.get('foo').catch(done)
        })

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, 'get')
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
              serviceName: 'custom-test',
            },
            v1: {
              opName: 'valkey.command',
              serviceName: 'custom',
            },
          }
        )
      })

      describe('with legacy configuration', () => {
        before(() => agent.load('iovalkey', {
          whitelist: ['get'],
        }))

        after(() => agent.close({ ritmReset: false }))

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, 'get')
            })
            .then(done)
            .catch(done)

          valkey.get('foo').catch(done)
        })
      })
    })
  })
})
