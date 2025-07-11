'use strict'

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()
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
                expect(results).to.not.be.null
                expect(fields).to.not.be.null
                expect(tracer.scope().active()).to.equal(span)
              } catch (e) {
                done(e)
              }
              done()
            })
          })
        })

        it('should run the callback in the parent context', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should run event listeners in the parent context', done => {
          const query = connection.query('SELECT 1 + 1 AS solution')

          query.on('end', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.name', 'db')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mariadb')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'mariadb')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'mariadb')
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
                expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
                expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
                expect(traces[0][0]).to.have.property('resource', 'SELECT ? + ? AS solution')
                expect(traces[0][0]).to.have.property('type', 'sql')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('db.name', 'db')
                expect(traces[0][0].meta).to.have.property('db.user', 'root')
                expect(traces[0][0].meta).to.have.property('db.type', 'mariadb')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('component', 'mariadb')
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
                expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
                expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
                expect(traces[0][0]).to.have.property('resource', 'SELECT ? + ? AS solution')
                expect(traces[0][0]).to.have.property('type', 'sql')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('db.name', 'db')
                expect(traces[0][0].meta).to.have.property('db.user', 'root')
                expect(traces[0][0].meta).to.have.property('db.type', 'mariadb')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('component', 'mariadb')
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
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'mariadb')
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
              expect(traces[0][0]).to.have.property('service', 'custom')
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
            expect(traces[0][0]).to.have.property('service', 'custom')
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
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mariadb')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'mariadb')
            })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution')
        })

        it('should run the callback in the parent context', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should propagate context to callbacks', done => {
          const span1 = tracer.startSpan('test1')
          const span2 = tracer.startSpan('test2')

          tracer.trace('test', () => {
            tracer.scope().activate(span1, () => {
              pool.query('SELECT 1 + 1 AS solution', () => {
                expect(tracer.scope().active() === span1).to.eql(true)
                tracer.scope().activate(span2, () => {
                  pool.query('SELECT 1 + 1 AS solution', () => {
                    expect(tracer.scope().active() === span2).to.eql(true)
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
            expect(traces).to.have.length(1)
            expect(traces[0].find(span => span.name === 'tcp.connect')).to.be.undefined
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
