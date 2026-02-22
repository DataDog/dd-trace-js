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
  let mysql
  let tracer

  describe('mysql', () => {
    withVersions('mysql', 'mysql', version => {
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
          await agent.load('mysql')
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()
          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          rawExpectedSchema.outbound
        )

        it('should propagate context to callbacks, with correct callback args', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            const span = tracer.scope().active()
            connection.query('SELECT 1 + 1 AS solution', (err, results, fields) => {
              assert.notStrictEqual(results, null)
              assert.notStrictEqual(fields, null)
              assert.strictEqual(tracer.scope().active(), span)
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
                component: 'mysql',
                '_dd.integration': 'mysql',
              },
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
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
                  component: 'mysql',
                },
              })
            })
            .then(done)
            .catch(done)

          connection.query('INVALID', (err, results, fields) => {
            error = err
          })
        })

        it('should work without a callback', done => {
          agent.assertSomeTraces(traces => {
            done()
          })

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
          await agent.load('mysql', { service: 'custom' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: 'custom',
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', () => {})
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
          await agent.load('mysql', { service: serviceSpy })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, 'custom')
            sinon.assert.calledWith(serviceSpy, sinon.match({
              host: 'localhost',
              user: 'root',
              database: 'db',
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
          await agent.load('mysql')
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
        })

        withPeerService(
          () => tracer,
          'mysql',
          (done) => pool.query('SELECT 1', (_) => done()),
          'db',
          'db.name'
        )

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
                component: 'mysql',
              },
            })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution', () => {})
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

      describe('comment injection interaction with peer service', () => {
        let connection
        let computeStub
        let remapStub

        before(async () => {
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        beforeEach(() => {
          const plugin = tracer._pluginManager._pluginsByName.mysql
          computeStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService')
          remapStub = sinon.stub(plugin._tracerConfig, 'peerServiceMapping')
        })

        afterEach(() => {
          computeStub.restore()
          remapStub.restore()
        })

        it('should use the service name when peer service is not available', done => {
          computeStub.value(false)
          remapStub.value({})
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\'' +
                `,ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('should use the peer service when peer service is available', done => {
          computeStub.value(true)
          remapStub.value({})
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'db\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\'' +
                `,ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('should use the remapped peer service when peer service is available and remapped', done => {
          computeStub.value(true)
          remapStub.value({ db: 'remappedDB' })
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'remappedDB\',dde=\'tester\',ddh=\'127.0.0.1\',' +
                `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('should contain comment in query text', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('trace query resource should not be changed when propagation is enabled', done => {
          agent
            .assertFirstTraceSpan({
              resource: 'SELECT 1 + 1 AS solution',
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

      describe('with DBM propagation enabled with service using tracer configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql', { service: 'serviced', dbmPropagationMode: 'service' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        after((done) => {
          connection.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        it('should contain service mode comment in query text', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
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
          await agent.load('mysql', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('DBM propagation should handle special characters', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
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
          await agent.load('mysql', { dbmPropagationMode: 'full', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
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
          connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connection._protocol._queue[0].sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            assert.match(queryText, /-00'\*\/ SELECT 1 \+ 1 AS solution/)
          }).then(done, done)

          connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connection._protocol._queue[0].sql
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
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
        })

        it('should contain comment in query text', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(pool._allConnections[0]._protocol._queue[0].sql,
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
          await agent.load('mysql', { dbmPropagationMode: 'full', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
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
          pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = pool._allConnections[0]._protocol._queue[0].sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(() => {
            assert.match(queryText, /-00'\*\/ SELECT 1 \+ 1 AS solution/)
          }).then(done, done)

          pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = pool._allConnections[0]._protocol._queue[0].sql
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
    })
  })
})
