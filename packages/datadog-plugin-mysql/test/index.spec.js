'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

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
            database: 'db'
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
              expect(results).to.not.be.null
              expect(fields).to.not.be.null
              expect(tracer.scope().active()).to.equal(span)
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
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.name', 'db')
            expect(traces[0][0].meta).to.have.property('db.user', 'root')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
            expect(traces[0][0].meta).to.have.property('component', 'mysql')

            done()
          })

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        it('should handle errors', done => {
          let error

          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
            expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
            expect(traces[0][0].meta).to.have.property('component', 'mysql')

            done()
          })

          connection.query('INVALID', (err, results, fields) => {
            error = err
          })
        })

        it('should work without a callback', done => {
          agent.use(traces => {
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
            database: 'db'
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
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
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            expect(traces[0][0]).to.have.property('service', 'custom')
            done()
          })

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
            database: 'db'
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
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
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
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
          await agent.load('mysql')
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
            database: 'db'
          })
        })

        withPeerService(
          () => tracer,
          'mysql',
          () => pool.query('SELECT 1', (_) => {}),
          'db', 'db.name')

        it('should do automatic instrumentation', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.user', 'root')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
            expect(traces[0][0].meta).to.have.property('component', 'mysql')

            done()
          })

          pool.query('SELECT 1 + 1 AS solution', () => {})
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

      describe('comment injection interaction with peer service', () => {
        let connection
        let computeStub
        let remapStub

        before(async () => {
          await agent.load('mysql', [{ dbmPropagationMode: 'service', service: 'serviced' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        beforeEach(() => {
          const plugin = tracer._pluginManager._pluginsByName['mysql']
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
              expect(connection._protocol._queue[0].sql).to.equal(
                `/*dddbs='serviced',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
              expect(connection._protocol._queue[0].sql).to.equal(
                `/*dddbs='db',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
              expect(connection._protocol._queue[0].sql).to.equal(
                `/*dddbs='remappedDB',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
          await agent.load('mysql', [{ dbmPropagationMode: 'service', service: 'serviced' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('should contain comment in query text', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              expect(connection._protocol._queue[0].sql).to.equal(
                `/*dddbs='serviced',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT 1 + 1 AS solution`)
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
          await agent.load('mysql', [{ dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('DBM propagation should handle special characters', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              expect(connection._protocol._queue[0].sql).to.equal(
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
          await agent.load('mysql', [{ dbmPropagationMode: 'full', service: 'post' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
          connection.connect()
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.use(traces => {
            const expectedTimePrefix = Math.floor(clock.now / 1000).toString(16).padStart(8, '0').padEnd(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            expect(queryText).to.equal(
              `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0',` +
              `traceparent='00-${traceId}-${spanId}-00'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const clock = sinon.useFakeTimers(new Date())
          connection.query('SELECT 1 + 1 AS solution', () => {
            clock.restore()
            queryText = connection._protocol._queue[0].sql
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
          await agent.load('mysql', [{ dbmPropagationMode: 'service', service: 'post' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
        })

        it('should contain comment in query text', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            try {
              expect(pool._allConnections[0]._protocol._queue[0].sql).to.equal(
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
          await agent.load('mysql', [{ dbmPropagationMode: 'full', service: 'post' }])
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db'
          })
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.use(traces => {
            const expectedTimePrefix = Math.floor(clock.now / 1000).toString(16).padStart(8, '0').padEnd(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            expect(queryText).to.equal(
              `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0',` +
              `traceparent='00-${traceId}-${spanId}-00'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const clock = sinon.useFakeTimers(new Date())
          pool.query('SELECT 1 + 1 AS solution', () => {
            clock.restore()
            queryText = pool._allConnections[0]._protocol._queue[0].sql
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
