'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()

describe('Plugin', () => {
  let mariadb
  let tracer

  describe('mariadb', () => {
    withVersions('mariadb', 'mariadb', version => {
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

        beforeEach(async (done) => {
          await agent.load('mariadb')
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect(err => {
            if (err) {
              done(err)
            } else {
              done()
            }
          })
        })

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
            expect(traces[0][0]).to.have.property('service', 'test-mariadb')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')

            done()
          })

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        it('should handle errors', done => {
          let error

          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)

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

        beforeEach(async (done) => {
          await agent.load('mariadb', { service: 'custom' })
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect(err => {
            if (err) {
              done(err)
            } else {
              done()
            }
          })
        })

        it('should be configured with the correct values', done => {
          agent.use(traces => {
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

        beforeEach(async (done) => {
          await agent.load('mariadb', { service: serviceSpy })
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect(err => {
            if (err) {
              done(err)
            } else {
              done()
            }
          })
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
          await agent.load('mariadb')
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

          pool = mariadb.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
            database: 'db'
          })
        })

        it('should do automatic instrumentation', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'test-mariadb')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')

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
    })
  })
})
