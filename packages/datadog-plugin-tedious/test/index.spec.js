'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const MSSQL_USERNAME = 'sa'
const MSSQL_PASSWORD = 'DD_HUNTER2'

wrapIt()

describe('Plugin', () => {
  let tds
  let tracer
  let connection

  withVersions(plugin, 'tedious', version => {
    beforeEach(() => {
      tracer = require('../../dd-trace')
    })

    describe('without configuration', () => {
      let config

      beforeEach(() => {
        return agent.load(plugin, 'tedious').then(() => {
          tds = require(`../../../versions/tedious@${version}`).get()
        })
      })

      after(() => {
        return agent.close()
      })

      beforeEach((done) => {
        config = {
          server: 'localhost',
          options: {
            database: 'master'
          }
        }
        if (version === '3.0.0') {
          config.userName = MSSQL_USERNAME
          config.password = MSSQL_PASSWORD
        } else {
          config.authentication = {
            options: {
              userName: MSSQL_USERNAME,
              password: MSSQL_PASSWORD
            },
            type: 'default'
          }
        }
        connection = new tds.Connection(config)
          .on('connect', err => done(err))
      })

      afterEach(() => {
        connection.close()
      })

      it('should run the callback in the parent context', done => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const span = tracer.startSpan('test')

        tracer.scope().activate(span, () => {
          const span = tracer.scope().active()
          const request = new tds.Request('SELECT 1 + 1 AS solution', (err) => {
            expect(tracer.scope().active()).to.equal(span)
            done(err)
          })
          connection.execSql(request)
        })
      })

      it('should do automatic instrumentation', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + 1 AS solution')
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('component', 'tedious')
            expect(traces[0][0].meta).to.have.property('db.name', 'master')
            expect(traces[0][0].meta).to.have.property('db.user', 'sa')
            expect(traces[0][0].meta).to.have.property('db.type', 'mssql')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          })
          .then(done)
          .catch(done)

        const request = new tds.Request('SELECT 1 + 1 AS solution', (err) => {
          if (err) done(err)
        })
        connection.execSql(request)
      })

      it('should handle parameterized queries', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', 'SELECT 1 + @num AS solution')
          })
          .then(done)
          .catch(done)

        const request = new tds.Request('SELECT 1 + @num AS solution', (err) => {
          if (err) done(err)
        })
        request.addParameter('num', tds.TYPES.Int, 1)
        connection.execSql(request)
      })

      it('should handle errors', done => {
        let error

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
          })
          .then(done)
          .catch(done)

        const request = new tds.Request('INVALID', (err) => {
          error = err
        })
        connection.execSql(request)
      })
    })
  })
})
