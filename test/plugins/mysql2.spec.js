'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/mysql2')

wrapIt()

describe('Plugin', () => {
  let mysql2
  let tracer

  describe('mysql2', () => {
    withVersions(plugin, 'mysql2', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        agent.close()
        agent.wipe()
      })

      describe('without configuration', () => {
        let connection

        beforeEach(() => {
          return agent.load(plugin, 'mysql2')
            .then(() => {
              mysql2 = require(`./versions/mysql2@${version}`).get()

              connection = mysql2.createConnection({
                host: 'localhost',
                user: 'root',
                database: 'db'
              })

              connection.connect()
            })
        })

        afterEach(done => {
          connection.end(done)
        })

        it('should propagate context to callbacks', done => {
          const span = tracer.startSpan('test')
          const scope = tracer.scopeManager().activate(span)

          connection.query('SELECT 1 + 1 AS solution', () => {
            const active = tracer.scopeManager().active()
            expect(active.span()).to.equal(scope.span())
            done()
          })
        })

        it('should run the callback in the parent context', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            const active = tracer.scopeManager().active()
            expect(active).to.be.null
            done()
          })
        })

        it('should run event listeners in the parent context', done => {
          const query = connection.query('SELECT 1 + 1 AS solution')

          query.on('result', () => {
            const active = tracer.scopeManager().active()
            expect(active).to.be.null
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-mysql')
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('db.name', 'db')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
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
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
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
        let config

        beforeEach(() => {
          config = {
            service: 'custom'
          }

          return agent.load(plugin, 'mysql2', config)
            .then(() => {
              mysql2 = require(`./versions/mysql2@${version}`).get()

              connection = mysql2.createConnection({
                host: 'localhost',
                user: 'root',
                database: 'db'
              })

              connection.connect()
            })
        })

        afterEach(done => {
          connection.end(done)
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

      describe('with a connection pool', () => {
        let pool

        beforeEach(() => {
          return agent.load(plugin, 'mysql2')
            .then(() => {
              mysql2 = require(`./versions/mysql2@${version}`).get()

              pool = mysql2.createPool({
                connectionLimit: 10,
                host: 'localhost',
                user: 'root'
              })
            })
        })

        afterEach(done => {
          pool.end(done)
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-mysql')
              expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('db.user', 'root')
              expect(traces[0][0].meta).to.have.property('db.type', 'mysql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution')
        })

        it('should run the callback in the parent context', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            const active = tracer.scopeManager().active()
            expect(active).to.be.null
            done()
          })
        })
      })
    })
  })
})
