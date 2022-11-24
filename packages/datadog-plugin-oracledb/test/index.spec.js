'use strict'

const agent = require('../../dd-trace/test/plugins/agent')

const hostname = process.env.CI ? 'oracledb' : 'localhost'
const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:1521/xepdb1`
}

const dbQuery = 'select current_timestamp from dual'

describe('Plugin', () => {
  let oracledb
  let connection
  let pool
  let tracer

  describe('oracledb', () => {
    withVersions('oracledb', 'oracledb', version => {
      describe('without configuration', () => {
        before(async () => {
          await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
        })
        after(async () => {
          await agent.close({ ritmReset: false })
        })

        describe('with connection', () => {
          before(async () => {
            connection = await oracledb.getConnection(config)
          })
          after(async () => {
            await connection.close()
          })

          connectionTests(new URL('http://' + config.connectString))
        })

        describe('with connection and connect descriptor', () => {
          before(async () => {
            connection = await oracledb.getConnection({
              ...config,
              connectString: `
                (DESCRIPTION=
                  (ADDRESS=(PROTOCOL=TCP)(HOST=${hostname})(PORT=1521))
                  (CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1))
                )
              `
            })
          })
          after(async () => {
            await connection.close()
          })

          connectionTests()
        })

        function connectionTests (url) {
          it('should be instrumented for promise API', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('db.port', url.port)
              }
            }).then(done, done)
            connection.execute(dbQuery)
          })

          it('should restore the parent context in the promise callback', () => {
            const span = {}
            return tracer.scope().activate(span, () => {
              return connection.execute(dbQuery).then(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
            })
          })

          it('should be instrumented for callback API', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('db.port', url.port)
              }
            }).then(done, done)

            connection.execute(dbQuery, err => err && done(err))
          })

          it('should restore the parent context in the callback', done => {
            const span = {}
            tracer.scope().activate(span, () => {
              connection.execute(dbQuery, () => {
                try {
                  expect(tracer.scope().active()).to.equal(span)
                } catch (e) {
                  return done(e)
                }
                done()
              })
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
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('db.port', url.port)
              }
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            }).then(done, done)

            connection.execute('invalid', err => {
              error = err
            })
          })
        }

        describe('with pool', () => {
          before(async () => {
            pool = await oracledb.createPool(config)
            connection = await pool.getConnection()
          })
          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests(new URL('http://' + config.connectString))
        })

        describe('with pool and connect descriptor', () => {
          before(async () => {
            pool = await oracledb.createPool({
              ...config,
              connectString: `
                (DESCRIPTION=
                  (ADDRESS=(PROTOCOL=TCP)(HOST=${hostname})(PORT=1521))
                  (CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1))
                )
              `
            })
            connection = await pool.getConnection()
          })
          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests()
        })

        function poolTests (url) {
          it('should be instrumented correctly with correct tags', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'oracle.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('db.port', url.port)
              }
            }).then(done, done)
            connection.execute(dbQuery)
          })

          it('should restore the parent context in the callback', () => {
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
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('db.port', url.port)
              }
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })

            connection.execute('invalid').catch(err => {
              error = err
            })

            return promise
          })
        }
      })
    })
  })
})
