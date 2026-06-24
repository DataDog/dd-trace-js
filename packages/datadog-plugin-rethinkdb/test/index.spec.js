'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_TYPE, ERROR_MESSAGE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let r
  let tracer

  describe('rethinkdb', () => {
    withVersions('rethinkdb', 'rethinkdb', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        r = require(`../../../versions/rethinkdb@${version}`).get()
      })

      describe('without configuration', () => {
        let connection

        before(() => agent.load('rethinkdb'))
        after(() => agent.close({ ritmReset: false }))

        beforeEach(done => {
          r.connect({ host: '127.0.0.1', port: 28015 }, (err, conn) => {
            if (err) return done(err)
            connection = conn
            done()
          })
        })

        afterEach(done => {
          connection.close(done)
        })

        withPeerService(
          () => tracer,
          'rethinkdb',
          () => r.tableList().run(connection),
          '127.0.0.1',
          'out.host'
        )

        withNamingSchema(
          done => r.tableList().run(connection, err => err && done(err)),
          rawExpectedSchema.outbound
        )

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'r.tableList()',
              type: 'rethinkdb',
              meta: {
                'db.type': 'rethinkdb',
                'out.host': '127.0.0.1',
                'span.kind': 'client',
                component: 'rethinkdb',
              },
            })
            .then(done)
            .catch(done)

          r.tableList().run(connection, err => err && done(err))
        })

        it('should set the database name tag', done => {
          agent
            .assertFirstTraceSpan({
              meta: {
                'db.name': 'test',
              },
            })
            .then(done)
            .catch(done)

          r.tableList().run(connection, { db: 'test' }, err => err && done(err))
        })

        it('should handle errors', done => {
          let error

          agent
            .assertFirstTraceSpan(trace => {
              assert.strictEqual(trace.error, 1)
              assert.ok(trace.meta[ERROR_TYPE])
              assert.ok(trace.meta[ERROR_MESSAGE])
              assert.ok(trace.meta[ERROR_STACK])
            })
            .then(done)
            .catch(done)

          r.table('nonexistent_table_that_does_not_exist').get('id').run(connection, err => {
            error = err
            if (!error) done(new Error('Expected an error'))
          })
        })

        it('should run the callback in the parent context', done => {
          const scope = tracer.scope()
          const parent = tracer.startSpan('test')

          scope.activate(parent, () => {
            r.tableList().run(connection, () => {
              assert.strictEqual(tracer.scope().active(), parent)
              parent.finish()
              done()
            })
          })
        })
      })

      describe('with configuration', () => {
        let connection

        before(() => agent.load('rethinkdb', { service: 'custom' }))
        after(() => agent.close({ ritmReset: false }))

        beforeEach(done => {
          r.connect({ host: '127.0.0.1', port: 28015 }, (err, conn) => {
            if (err) return done(err)
            connection = conn
            done()
          })
        })

        afterEach(done => {
          connection.close(done)
        })

        withNamingSchema(
          done => r.tableList().run(connection, err => err && done(err)),
          {
            v0: {
              opName: 'rethinkdb.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'rethinkdb.query',
              serviceName: 'custom',
            },
          },
          {
            hooks: (versionName, defaultToGlobalService) => {
              it('should use the custom service name', done => {
                agent
                  .assertFirstTraceSpan({
                    service: 'custom',
                  })
                  .then(done)
                  .catch(done)

                r.tableList().run(connection, err => err && done(err))
              })
            },
          }
        )
      })
    })
  })
})
