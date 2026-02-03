'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// https://github.com/mariadb-corporation/mariadb-connector-nodejs/commit/0a90b71ab20ab4e8b6a86a77ba291bba8ba6a34e
const range = semver.gte(process.version, '15.0.0') ? '>=2.5.1' : '>=2'

describe('Plugin', () => {
  describe('mariadb', () => {
    withVersions('mariadb', 'mariadb', range, version => {
      let tracer

      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration - callbacks', () => {
        let mariadb
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
            database: 'db',
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
          agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'SELECT 1 + 1 AS solution',
            type: 'sql',
            meta: {
              'span.kind': 'client',
              'db.name': 'db',
              'db.user': 'root',
              'db.type': 'mariadb',
              component: 'mariadb',
              '_dd.integration': 'mariadb',
            },
          })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        if (semver.intersects(version, '>=3')) {
          it('should support prepared statement shorthand', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mariadb',
                component: 'mariadb',
              },
            })
              .then(done)
              .catch(done)

            connection.execute('SELECT ? + ? AS solution', [1, 1], (error, results, fields) => {
              if (error) throw error
            })
          })

          it('should support prepared statements', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mariadb',
                component: 'mariadb',
              },
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
              assertObjectContains(traces[0][0].meta, {
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                component: 'mariadb',
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
            .assertFirstTraceSpan({ resource: 'SELECT 1 + 1 AS solution' })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      if (semver.intersects(version, '>=3')) {
        describe('without configuration - promises', () => {
          let mariadb
          let connection

          afterEach(async () => {
            await connection.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load('mariadb')
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          withNamingSchema(
            () => connection.query('SELECT 1'),
            rawExpectedSchema.outbound
          )

          withPeerService(
            () => tracer,
            'mariadb',
            () => connection.query('SELECT 1'),
            'db',
            'db.name'
          )

          it('should propagate context to promise continuations', async () => {
            const span = tracer.startSpan('test')

            await tracer.scope().activate(span, () => {
              return connection.query('SELECT 1 + 1 AS solution').then((results) => {
                assert.notStrictEqual(results, null)
                assert.strictEqual(tracer.scope().active(), span)
              })
            })
          })

          it('should run promise continuations in the parent context', async () => {
            await connection.query('SELECT 1 + 1 AS solution').then(() => {
              assert.strictEqual(tracer.scope().active(), null)
            })
          })

          it('should run event listeners in the parent context', done => {
            if (typeof connection.queryStream !== 'function') return done()

            const stream = connection.queryStream('SELECT 1 + 1 AS solution')

            stream.once('error', done)
            stream.once('end', () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })

            stream.resume()
          })

          it('should do automatic instrumentation', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT 1 + 1 AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                  '_dd.integration': 'mariadb',
                },
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          it('should work without a callback', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({ resource: 'SELECT 1 + 1 AS solution' }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          it('should support prepared statement shorthand', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT ? + ? AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ }),
              connection.execute('SELECT ? + ? AS solution', [1, 1]),
            ])
          })

          it('should support prepared statements', async () => {
            const statement = await connection.prepare('SELECT ? + ? AS solution')

            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT ? + ? AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ }),
              statement.execute([1, 1]),
            ])

            await statement.close()
          })

          it('should handle errors', async () => {
            const queryPromise = connection.query('SELECT * FROM definitely_missing_table').catch(() => {})

            await Promise.all([
              agent.assertFirstTraceSpan({
                resource: 'SELECT * FROM definitely_missing_table',
                meta: {
                  component: 'mariadb',
                  [ERROR_TYPE]: ANY_STRING,
                  [ERROR_MESSAGE]: ANY_STRING,
                  [ERROR_STACK]: ANY_STRING,
                },
              }, { spanResourceMatch: /definitely_missing_table/ }),
              queryPromise,
            ])
          })

        })
      }

      if (semver.intersects(version, '>=2.5.2 <3')) {
        describe('without configuration - promise rejection tagging (<3)', () => {
          let mariadb
          let connection

          afterEach(async () => {
            await connection.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load('mariadb')
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')
            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          it('should tag promise rejections with error details', async () => {
            let error

            const assertion = agent.assertSomeTraces(traces => {
              if (!error) throw new Error('Expected error to be set')

              assertObjectContains(traces[0][0].meta, {
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                component: 'mariadb',
              })
            }, { spanResourceMatch: /definitely_missing_table/ })

            // For >=2.5.2 <3, mariadb uses `_queryPromise` internally for promise queries.
            await connection._queryPromise('SELECT * FROM definitely_missing_table').catch((e) => { error = e })

            await assertion
          })
        })
      }

      describe('with configuration - callbacks', () => {
        let connection
        let mariadb

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
            database: 'db',
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
              serviceName: 'custom',
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
          }
        )
      })

      if (semver.intersects(version, '>=3')) {
        describe('with configuration - promises', () => {
          let connection
          let mariadb

          afterEach(async () => {
            await connection.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load('mariadb', { service: 'custom' })
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          it('should be configured with the correct values', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({ service: 'custom' }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          withNamingSchema(
            () => connection.query('SELECT 1 + 1 AS solution'),
            {
              v0: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
              v1: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
            }
          )
        })
      }

      describe('with service configured as function - callbacks', () => {
        const serviceSpy = sinon.stub().returns('custom')
        let connection
        let mariadb

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
            database: 'db',
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
              serviceName: 'custom',
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
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

      if (semver.intersects(version, '>=3')) {
        describe('with service configured as function - promises', () => {
          const serviceSpy = sinon.stub().returns('custom')
          let connection
          let mariadb

          afterEach(async () => {
            await connection.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load('mariadb', { service: serviceSpy })
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          withNamingSchema(
            () => connection.query('SELECT 1 + 1 AS solution'),
            {
              v0: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
              v1: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
            }
          )

          it('should be configured with the correct values', async () => {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, 'custom')
                sinon.assert.calledWith(serviceSpy, sinon.match({
                  host: 'localhost',
                  user: 'root',
                  database: 'db',
                }))
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })
        })
      }

      describe('with a connection pool - callbacks', () => {
        let pool
        let mariadb

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
            user: 'root',
          })
        })

        it('should do automatic instrumentation', done => {
          agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'SELECT 1 + 1 AS solution',
            type: 'sql',
            meta: {
              'span.kind': 'client',
              'db.user': 'root',
              'db.type': 'mariadb',
              component: 'mariadb',
            },
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

      if (semver.intersects(version, '>=3')) {
        describe('with a connection pool - promises', () => {
          let pool
          let mariadb

          afterEach(async () => {
            await pool.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load('mariadb')
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

            pool = mariadb.createPool({
              connectionLimit: 1,
              host: 'localhost',
              user: 'root',
            })
          })

          it('should do automatic instrumentation', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT 1 + 1 AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              pool.query('SELECT 1 + 1 AS solution'),
            ])
          })

          it('should run promise continuations in the parent context', async () => {
            await pool.query('SELECT 1 + 1 AS solution').then(() => {
              assert.strictEqual(tracer.scope().active(), null)
            })
          })

          it('should propagate context to promise continuations', async () => {
            const span1 = tracer.startSpan('test1')
            const span2 = tracer.startSpan('test2')

            await tracer.trace('test', () => {
              return tracer.scope().activate(span1, () => {
                return pool.query('SELECT 1 + 1 AS solution').then(() => {
                  assert.deepStrictEqual(tracer.scope().active() === span1, true)
                  return tracer.scope().activate(span2, () => {
                    return pool.query('SELECT 1 + 1 AS solution').then(() => {
                      assert.deepStrictEqual(tracer.scope().active() === span2, true)
                    })
                  })
                })
              })
            })
          })
        })
      }

      describe('with a connection pool started during a request - callbacks', () => {
        let pool
        let mariadb

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
              minimumIdle: 1,
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

      if (semver.intersects(version, '>=3')) {
        describe('with a connection pool started during a request - promises', () => {
          let pool
          let mariadb

          afterEach(async () => {
            await pool.end()
            await agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            await agent.load(['mariadb', 'net'])
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')
          })

          it('should not instrument connections to avoid leaks from internal queue', async () => {
            const span = tracer.startSpan('test')

            const assertion = agent.assertSomeTraces((traces) => {
              assert.strictEqual(traces.length, 1)
              assert.strictEqual(traces[0].find(s => s.name === 'tcp.connect'), undefined)
            })

            await tracer.scope().activate(span, async () => {
              pool = pool || mariadb.createPool({
                host: 'localhost',
                user: 'root',
                database: 'db',
                connectionLimit: 3,
                idleTimeout: 1,
                minimumIdle: 1,
              })

              const conn = await pool.getConnection()
              await conn.query('SELECT 1 + 1 AS solution')
              await conn.end()
              span.finish()
            })

            await assertion
          })
        })
      }
    })
  })
})
