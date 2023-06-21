'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const namingSchema = require('./naming')

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
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

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

          query.on('result', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', namingSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', namingSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.name', 'db')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('component', 'mysql2')
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        it('should support prepared statement shorthand', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', namingSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', namingSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT ? + ? AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.name', 'db')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('component', 'mysql2')
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
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', namingSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', namingSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT ? + ? AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.name', 'db')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('component', 'mysql2')
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
            .use(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'mysql2')
            })
            .then(done)
            .catch(done)

          connection.query('INVALID', (err, results, fields) => {
            error = err
          })
        })

        it('should work without a callback', done => {
          agent
            .use(() => {})
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
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
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
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        it('should be configured with the correct values', done => {
          agent.use(traces => {
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
          await agent.load('mysql2')
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root'
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', namingSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', namingSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('component', 'mysql2')
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
      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql2', [{ dbmPropagationMode: 'service', service: 'serviced' }])
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
              expect(connect.sql).to.equal(`/*dddbs='serviced',dde='tester',` +
              `ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })
        it('trace query resource should not be changed when propagation is enabled', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            done()
          })
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
          await agent.load('mysql2', [{ dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' }])
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
              expect(connect.sql).to.equal(
                `/*dddbs='~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E',dde='tester',` +
              `ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
        })

        beforeEach(async () => {
          await agent.load('mysql2', [{ dbmPropagationMode: 'full', service: 'post' }])
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
          agent.use(traces => {
            const traceId = traces[0][0].trace_id.toString(16).padStart(32, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            expect(queryText).to.equal(
              `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0',` +
            `traceparent='00-${traceId}-${spanId}-00'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connect.sql
          })
        })
        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('_dd.dbm_trace_injected', 'true')
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
          await agent.load('mysql2', [{ dbmPropagationMode: 'service', service: 'post' }])
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
              expect(queryPool.sql).to.equal(
                `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
        })

        beforeEach(async () => {
          await agent.load('mysql2', [{ dbmPropagationMode: 'full', service: 'post' }])
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
          agent.use(traces => {
            const traceId = traces[0][0].trace_id.toString(16).padStart(32, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            expect(queryText).to.equal(
              `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0',` +
            `traceparent='00-${traceId}-${spanId}-00'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = queryPool.sql
          })
        })
        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('_dd.dbm_trace_injected', 'true')
            done()
          })
          pool.query('SELECT 1 + 1 AS solution', () => {
          })
        })
      })
    })
  })
})
