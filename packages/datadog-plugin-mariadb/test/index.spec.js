'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

// https://github.com/mariadb-corporation/mariadb-connector-nodejs/commit/0a90b71ab20ab4e8b6a86a77ba291bba8ba6a34e
const range = semver.gte(process.version, '15.0.0') ? '>=2.5.1' : '>=2'

describe('Plugin', () => {
  let mariadb
  let tracer

  describe('mariadb', () => {
    withVersions('mariadb', 'mariadb', range, version => {
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
          await agent.load('mariadb')
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        withNamingSchema(
          done => connection.query('SELECT 1', (_) => { }),
          rawExpectedSchema.outbound
        )

        withPeerService(
          () => tracer,
          'mariadb',
          done => connection.query('SELECT 1', done),
          'db',
          'db.name'
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

          query.on('end', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'SELECT 1 + 1 AS solution')
              assert.strictEqual(traces[0][0].type, 'sql')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['db.name'], 'db')
              assert.strictEqual(traces[0][0].meta['db.user'], 'root')
              assert.strictEqual(traces[0][0].meta['db.type'], 'mariadb')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta.component, 'mariadb')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'mariadb')
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        if (semver.intersects(version, '>=3')) {
          it('should support prepared statement shorthand', done => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                assert.strictEqual(traces[0][0].resource, 'SELECT ? + ? AS solution')
                assert.strictEqual(traces[0][0].type, 'sql')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['db.name'], 'db')
                assert.strictEqual(traces[0][0].meta['db.user'], 'root')
                assert.strictEqual(traces[0][0].meta['db.type'], 'mariadb')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta.component, 'mariadb')
              })
              .then(done)
              .catch(done)

            connection.execute('SELECT ? + ? AS solution', [1, 1], (error, results, fields) => {
              if (error) throw error
            })
          })

          it('should support prepared statements', done => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                assert.strictEqual(traces[0][0].resource, 'SELECT ? + ? AS solution')
                assert.strictEqual(traces[0][0].type, 'sql')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['db.name'], 'db')
                assert.strictEqual(traces[0][0].meta['db.user'], 'root')
                assert.strictEqual(traces[0][0].meta['db.type'], 'mariadb')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta.component, 'mariadb')
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
        }

        it('should handle errors', done => {
          let error

          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][0].meta.component, 'mariadb')
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
          await agent.load('mariadb', { service: 'custom' })
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'custom')
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution'),
          {
            v0: {
              opName: 'mariadb.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom'
            }
          }
        )
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
          await agent.load('mariadb', { service: serviceSpy })
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          {
            v0: {
              opName: 'mariadb.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom'
            }
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            sinon.assert.calledWith(serviceSpy, sinon.match({
              host: 'localhost',
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
          await agent.load('mariadb')
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          pool = mariadb.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root'
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'SELECT 1 + 1 AS solution')
              assert.strictEqual(traces[0][0].type, 'sql')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['db.user'], 'root')
              assert.strictEqual(traces[0][0].meta['db.type'], 'mariadb')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta.component, 'mariadb')
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

      describe('with a connection pool started during a request', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close({ ritmReset: false }).then(done)
          })
        })

        beforeEach(async () => {
          await agent.load(['mariadb', 'net'])
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')
        })

        it('should not instrument connections to avoid leaks from internal queue', done => {
          agent.assertSomeTraces((traces) => {
            assert.strictEqual(traces.length, 1)
            assert.strictEqual(traces[0].find(span => span.name === 'tcp.connect'), undefined)
          }).then(done, done)

          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            pool = pool || mariadb.createPool({
              host: 'localhost',
              user: 'root',
              database: 'db',
              connectionLimit: 3,
              idleTimeout: 1,
              minimumIdle: 1
            })

            pool.getConnection((err, conn) => {
              if (err) return done(err)
              conn.query('SELECT 1 + 1 AS solution', (err, results) => {
                if (err) return done(err)
                conn.end()
                span.finish()
              })
            })
          })
        })
      })
    })
  })
})
