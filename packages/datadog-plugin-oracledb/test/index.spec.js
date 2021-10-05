'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: 'localhost:1521/xepdb1'
}

const dbQuery = 'select current_timestamp from dual'

describe('Plugin', () => {
  let oracledb
  let connection
  let pool
  let tracer

  describe('oracledb', () => {
    withVersions(plugin, 'oracledb', version => {
      describe('without configuration', () => {
        before(async () => {
          await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
        })
        after(async () => {
          await agent.close()
        })

        describe('with connection', () => {
          before(async () => {
            connection = await oracledb.getConnection(config)
          })
          after(async () => {
            await connection.close()
          })

          it('should be instrumented for promise API', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xepdb1')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'localhost')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
            }).then(done, done)
            connection.execute(dbQuery)
          })

          it('should be instrumented for callback API', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xepdb1')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'localhost')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
            }).then(done, done)

            connection.execute(dbQuery, err => err && done(err))
          })

          it('should restore the parent context in the callback', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            connection.execute(dbQuery, () => {
              expect(tracer.scope().active()).to.be.null
              done()
            })
          })

          it('should instrument errors', done => {
            let error

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', 'invalid')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'invalid')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xepdb1')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'localhost')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            }).then(done, done)

            connection.execute('invalid', err => {
              error = err
            })
          })
        })

        describe('with pool', () => {
          before(async () => {
            pool = await oracledb.createPool(config)
            connection = await pool.getConnection()
          })
          after(async () => {
            await connection.close()
            await pool.close()
          })

          it('should be instrumented correctly with correct tags', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xepdb1')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'localhost')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
            }).then(done, done)
            connection.execute(dbQuery)
          })

          it('should restore the parent context in the callback', () => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

            return connection.execute(dbQuery).then(() => {
              expect(tracer.scope().active()).to.be.null
            })
          })

          it('should instrument errors', () => {
            let error

            const promise = agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', 'invalid')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'invalid')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xepdb1')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'localhost')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })

            connection.execute('invalid').catch(err => {
              error = err
            })

            return promise
          })
        })
      })
    })
  })
})
