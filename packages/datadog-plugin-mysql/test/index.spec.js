'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let mysql
  let tracer

  describe('mysql', () => {
    withVersions(plugin, 'mysql', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let connection

        before(() => {
          return agent.load('mysql')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          mysql = require(`../../../versions/mysql@${version}`).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        afterEach(done => {
          connection.end(done)
        })

        it('should propagate context to callbacks, with correct callback args', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          connection.query('SELECT 1 + 1 AS solution', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should run event listeners in the parent context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const query = connection.query('SELECT 1 + 1 AS solution')

          query.on('result', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'test-mysql')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.name', 'db')
            expect(traces[0][0].meta).to.have.property('db.user', 'root')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')

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

        before(() => {
          return agent.load('mysql', { service: 'custom' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          mysql = require(`../../../versions/mysql@${version}`).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })

          connection.connect()
        })

        afterEach(done => {
          connection.end(done)
        })

        it('should be configured with the correct values', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')
            done()
          })

          connection.query('SELECT 1 + 1 AS solution', () => {})
        })
      })

      describe('with a connection pool', () => {
        let pool

        before(() => {
          return agent.load('mysql')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          mysql = require(`../../../versions/mysql@${version}`).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
            database: 'db'
          })
        })

        afterEach(done => {
          pool.end(done)
        })

        it('should do automatic instrumentation', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'test-mysql')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('db.user', 'root')
            expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')

            done()
          })

          pool.query('SELECT 1 + 1 AS solution', () => {})
        })

        it('should run the callback in the parent context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          pool.query('SELECT 1 + 1 AS solution', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should propagate context to callbacks', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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
