'use strict'

const assert = require('node:assert/strict')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const ddpv = require('mocha/package.json').version
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let mysql2
  let tracer

  describe('mysql2', () => {
    withVersions('mysql2', 'mysql2', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2')
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        withPeerService(
          () => tracer,
          'mysql2',
          (done) => connection.query('SELECT 1', (_) => done()),
          'db',
          'db.name'
        )

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          rawExpectedSchema.outbound
        )

        it('should propagate context to callbacks, with correct callback args', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            const span = tracer.scope().active()

            connection.query('SELECT 1 + 1 AS solution', (err, results, fields) => {
              try {
                assert.notStrictEqual(results, null)
                assert.notStrictEqual(fields, null)
                assert.strictEqual(tracer.scope().active(), span)
              } catch (e) {
                done(e)
              }
              done()
            })
          })
        })

        it('should run the callback in the parent context', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should run event listeners in the parent context', done => {
          const query = connection.query('SELECT 1 + 1 AS solution')

          query.on('result', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT 1 + 1 AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2'
              }
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        it('should support prepared statement shorthand', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2'
              }
            })
            .then(done)
            .catch(done)

          connection.execute('SELECT ? + ? AS solution', [1, 1], (error, results, fields) => {
            if (error) throw error
          })

          connection.unprepare('SELECT ? + ? AS solution')
        })

        it('should support prepared statements', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2'
              }
            })
            .then(done)
            .catch(done)

          connection.prepare('SELECT ? + ? AS solution', (err, statement) => {
            if (err) throw err

            statement.execute([1, 1], (error, rows, columns) => {
              if (error) throw error
            })

            statement.close()
          })
        })

        it('should handle errors', done => {
          let error

          agent
            .assertFirstTraceSpan((trace) => {
              assertObjectContains(trace, {
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'mysql2'
                }
              })
            })
            .then(done)
            .catch(done)

          connection.query('INVALID', (err, results, fields) => {
            error = err
          })
        })

        it('should work without a callback', done => {
          agent
            .assertSomeTraces(() => {})
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      describe('with configuration', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { service: 'custom' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom'
            }
          }
        )

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              service: 'custom'
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      describe('with service configured as function', () => {
        const serviceSpy = sinon.stub().returns('custom')
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { service: serviceSpy })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom'
            }
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            sinon.assert.calledWith(serviceSpy, sinon.match({
              host: '127.0.0.1',
              user: 'root',
              database: 'db'
            }))
            done()
          })

          connection.query('SELECT 1 + 1 AS solution', () => {})
        })
      })

      describe('with a connection pool', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2')
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root'
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT 1 + 1 AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2'
              }
            })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution')
        })

        it('should run the callback in the parent context', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should propagate context to callbacks', done => {
          const span1 = tracer.startSpan('test1')
          const span2 = tracer.startSpan('test2')

          tracer.trace('test', () => {
            tracer.scope().activate(span1, () => {
              pool.query('SELECT 1 + 1 AS solution', () => {
                assert.deepStrictEqual(tracer.scope().active() === span1, true)
                tracer.scope().activate(span2, () => {
                  pool.query('SELECT 1 + 1 AS solution', () => {
                    assert.deepStrictEqual(tracer.scope().active() === span2, true)
                    done()
                  })
                })
              })
            })
          })
        })
      })
      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('should contain comment in query text', done => {
          const connect = connection.query('SELECT 1 + 1 AS solution', (...args) => {
            try {
              assert.strictEqual(connect.sql, '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',' +
              `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('trace query resource should not be changed when propagation is enabled', done => {
          agent
            .assertFirstTraceSpan({
              resource: 'SELECT 1 + 1 AS solution'
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (err) => {
            if (err) return done(err)
            connection.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })
      describe('DBM propagation should handle special characters', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('DBM propagation should handle special characters', done => {
          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connect.sql,
                '/*dddb=\'db\',dddbs=\'~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E\',dde=\'tester\',' +
                `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })
      describe('with DBM propagation enabled with full using tracer configurations', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })

          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'full', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='db',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
            `traceparent='00-${traceId}-${spanId}-01'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connect.sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.match(
              queryText,
              new RegExp(`traceparent='00\\-${traceId}\\-${spanId}\\-00'\\*\\/ SELECT 1 \\+ 1 AS solution`)
            )
          }).then(done, done)

          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connect.sql
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.dbm_trace_injected'], 'true')
            done()
          })
          connection.query('SELECT 1 + 1 AS solution', () => {
          })
        })
      })
      describe('with DBM propagation enabled with service using a connection pool', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
        })

        it('should contain comment in query text', done => {
          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(queryPool.sql,
                '/*dddb=\'db\',dddbs=\'post\',dde=\'tester\',ddh=\'127.0.0.1\',' +
                `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })
      })
      describe('with DBM propagation enabled with service using a connection pool', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })

          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'full', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='db',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
            `traceparent='00-${traceId}-${spanId}-01'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = queryPool.sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.match(
              queryText,
              new RegExp(`traceparent='00\\-${traceId}\\-${spanId}\\-00'\\*\\/ SELECT 1 \\+ 1 AS solution`)
            )
          }).then(done, done)

          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = queryPool.sql
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.dbm_trace_injected'], 'true')
            done()
          })
          pool.query('SELECT 1 + 1 AS solution', () => {
          })
        })
      })

      // Issue #7044
      describe('with mysql2/promise and appsec abort', () => {
        let pool
        let mysql2Promise
        let abortSubscriber

        afterEach(async function () {
          // Unsubscribe from abort channel
          if (abortSubscriber) {
            const dc = require('node:diagnostics_channel')
            const startOuterQueryCh = dc.channel('datadog:mysql2:outerquery:start')
            startOuterQueryCh.unsubscribe(abortSubscriber)
            abortSubscriber = null
          }

          if (pool) {
            await pool.end()
            pool = null
          }

          await agent.close({ ritmReset: false })
        })

        beforeEach(async function () {
          await agent.load('mysql2')
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          // Try to load mysql2/promise - skip if not available (very old mysql2 versions)
          try {
            const mysql2VersionWrapper = proxyquire(`../../../versions/mysql2@${version}`, {})
            mysql2Promise = mysql2VersionWrapper.get('mysql2/promise')
          } catch (e) {
            this.skip()
            return
          }

          pool = mysql2Promise.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })

          // Subscribe to the abort channel to trigger abort behavior
          const dc = require('node:diagnostics_channel')
          const startOuterQueryCh = dc.channel('datadog:mysql2:outerquery:start')
          abortSubscriber = ({ abortController }) => {
            abortController.abort(new Error('RASP blocked query'))
          }
          startOuterQueryCh.subscribe(abortSubscriber)
        })

        it('should return a rejected Promise when abort is triggered on pool.query()', async () => {
          // Issue #7044: When using mysql2/promise and appsec abort is triggered,
          // the instrumentation should return a rejected Promise, not a callback-style Query object

          let caughtError
          try {
            await pool.query('SELECT 1 + 1 AS solution')
          } catch (err) {
            caughtError = err
          }

          // Expected behavior: Should catch the abort error
          assert.ok(caughtError, 'Expected an error to be thrown')
          assert.strictEqual(caughtError.message, 'RASP blocked query',
            'Should receive the abort error, not a .then() TypeError')
        })

        it('should return a rejected Promise when abort is triggered on connection.query()', async () => {
          const connection = await pool.getConnection()

          let caughtError
          try {
            await connection.query('SELECT 1 + 1 AS solution')
          } catch (err) {
            caughtError = err
          } finally {
            connection.release()
          }

          // Expected behavior: Should catch the abort error
          assert.ok(caughtError, 'Expected an error to be thrown')
          assert.strictEqual(caughtError.message, 'RASP blocked query',
            'Should receive the abort error, not a .then() TypeError')
        })
      })
    })
  })
})
