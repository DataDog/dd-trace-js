'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const semver = require('semver')

const MSSQL_USERNAME = 'sa'
const MSSQL_PASSWORD = 'DD_HUNTER2'

wrapIt()

describe('Plugin', () => {
  let tds
  let tracer
  let connection
  let connectionIsClosed

  withVersions(plugin, 'tedious', version => {
    beforeEach(() => {
      tracer = require('../../dd-trace')
    })

    describe('without configuration', () => {
      let config

      beforeEach(() => {
        return agent.load('tedious').then(() => {
          tds = require(`../../../versions/tedious@${version}`).get()
        })
      })

      afterEach(() => {
        return agent.close()
      })

      beforeEach((done) => {
        config = {
          server: 'localhost',
          options: {
            database: 'master',
            trustServerCertificate: true
          }
        }
        if (semver.intersects(version, '>=4.0.0')) {
          config.authentication = {
            options: {
              userName: MSSQL_USERNAME,
              password: MSSQL_PASSWORD
            },
            type: 'default'
          }
        } else {
          config.userName = MSSQL_USERNAME
          config.password = MSSQL_PASSWORD
        }

        connectionIsClosed = false
        connection = new tds.Connection(config)
          .on('connect', done)

        // see https://github.com/tediousjs/tedious/releases/tag/v10.0.0
        if (semver.intersects(version, '>=10.0.0')) {
          connection.connect()
        }
      })

      afterEach(function (done) {
        if (connectionIsClosed) {
          done()
        } else {
          connection.on('end', () => done())
          connection.close()
        }
      })

      it('should run the Request callback in the parent context', done => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        const span = tracer.startSpan('test')
        const request = new tds.Request('SELECT 1 + 1 AS solution', (err) => {
          expect(tracer.scope().active()).to.equal(span)
          done(err)
        })

        tracer.scope().activate(span, () => {
          connection.execSql(request)
        })
      })

      it('should run the Request event listeners in the parent context', done => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        const span = tracer.startSpan('test')
        const request = new tds.Request('SELECT 1 + 1 AS solution', (err) => {
          if (err) done(err)
        })

        tracer.scope().activate(span, () => {
          request.on('requestCompleted', () => {
            expect(tracer.scope().active()).to.equal(span)
            done()
          })
        })
        connection.execSql(request)
      })

      it('should run the Connection event listeners in the parent context', done => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        const span = tracer.startSpan('test')

        tracer.scope().activate(span, () => {
          connection.on('end', () => {
            expect(tracer.scope().active()).to.equal(span)
            connectionIsClosed = true
            done()
          })
        })
        connection.close()
      })

      it('should do automatic instrumentation', done => {
        const query = 'SELECT 1 + 1 AS solution'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
            expect(traces[0][0]).to.have.property('type', 'sql')
            expect(traces[0][0].meta).to.have.property('component', 'tedious')
            expect(traces[0][0].meta).to.have.property('db.name', 'master')
            expect(traces[0][0].meta).to.have.property('db.user', 'sa')
            expect(traces[0][0].meta).to.have.property('db.type', 'mssql')
            expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].metrics).to.have.property('out.port', 1433)
          })

        const request = new tds.Request(query, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        })
        connection.execSql(request)
      })

      it('should handle parameterized queries', done => {
        const query = 'SELECT 1 + @num AS solution'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
          })

        const request = new tds.Request(query, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        })
        request.addParameter('num', tds.TYPES.Int, 1)
        connection.execSql(request)
      })

      it('should handle batch queries', done => {
        const query = 'SELECT 1 + 1 AS solution1;\n' +
                      'SELECT 1 + 2 AS solution2'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
          })

        const request = new tds.Request(query, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        })
        connection.execSqlBatch(request)
      })

      it('should handle prepare requests', done => {
        const query = 'SELECT 1 + @num AS solution'

        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
          })
          .then(done)
          .catch(done)

        const request = new tds.Request(query)

        request.addParameter('num', tds.TYPES.Int, 1)
        connection.prepare(request)
      })

      it('should handle execute requests', done => {
        const query = 'SELECT 1 + @num AS solution'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
          })

        const request = new tds.Request(query, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        }).on('prepared', () => {
          connection.execute(request, { num: 5 })
        })

        request.addParameter('num', tds.TYPES.Int)
        connection.prepare(request)
      })

      it('should handle unprepare requests', done => {
        const query = 'SELECT 1 + @num AS solution'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', query)
          })

        const request = new tds.Request(query, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        }).on('prepared', () => {
          connection.unprepare(request)
        })

        request.addParameter('num', tds.TYPES.Int, 1)
        connection.prepare(request)
      })

      it('should handle stored procedure calls', done => {
        const procedure = 'dbo.ddTestProc'

        const promise = agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'tedious.request')
            expect(traces[0][0]).to.have.property('service', 'test-mssql')
            expect(traces[0][0]).to.have.property('resource', procedure)
          })

        const request = new tds.Request(procedure, (err) => {
          if (err) return done(err)
          promise.then(done, done)
        })

        request.addParameter('num', tds.TYPES.Int, 1)
        connection.callProcedure(request)
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

      it('should handle cancelled requests', done => {
        const query = "SELECT 1 + 1 AS solution;waitfor delay '00:00:01'"

        let error

        agent
          .use(traces => {
            expect(error.message).to.equal('Canceled.')
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
          })
          .then(done)
          .catch(done)

        const request = new tds.Request(query, (err) => {
          error = err
        })

        connection.execSql(request)
        setTimeout(() => connection.cancel(), 0)
      })

      if (semver.intersects(version, '>=1.5.4')) {
        describe('instrument BulkLoad', () => {
          const tableName = 'TEST_TABLE'

          function buildBulkLoad () {
            let bulkLoad

            // newBulkLoad function definition changed in v2.2.0
            if (semver.intersects(version, '>=2.2.0')) {
              bulkLoad = connection.newBulkLoad(tableName, { keepNulls: true }, () => {})
            } else {
              bulkLoad = connection.newBulkLoad(tableName, () => {})
            }

            bulkLoad.addColumn('num', tds.TYPES.Int, { nullable: false })
            return bulkLoad
          }

          beforeEach(done => {
            const dropTestTable = new tds.Request(`DROP TABLE IF EXISTS ${tableName}`, (err) => {
              if (err) return done(err)

              const tableCreationSql = `CREATE TABLE ${tableName} ([num] int NOT NULL)`
              const createTestTable = new tds.Request(tableCreationSql, done)
              connection.execSql(createTestTable)
            })
            connection.execSql(dropTestTable)
          })

          it('should handle bulkload requests', done => {
            const bulkLoad = buildBulkLoad()

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('name', 'tedious.request')
                expect(traces[0][0]).to.have.property('resource', bulkLoad.getBulkInsertSql())
              })
              .then(done)
              .catch(done)

            connection.execBulkLoad(bulkLoad, [{ num: 5 }])
          })

          if (semver.intersects(version, '>=4.2.0') && !semver.intersects(version, '>=14')) {
            it('should handle streaming BulkLoad requests', done => {
              const bulkLoad = buildBulkLoad()
              const rowStream = bulkLoad.getRowStream()

              const promise = agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('name', 'tedious.request')
                  expect(traces[0][0]).to.have.property('resource', bulkLoad.getBulkInsertSql())
                })

              connection.execBulkLoad(bulkLoad)
              rowStream.write([5], (err) => {
                if (err) return done(err)
                rowStream.end()
                promise.then(done, done)
              })
            })

            it('should run the BulkLoad stream event listeners in the parent context', done => {
              const span = tracer.startSpan('test')
              const bulkLoad = buildBulkLoad()
              const rowStream = bulkLoad.getRowStream()

              tracer.scope().activate(span, () => {
                rowStream.on('finish', () => {
                  expect(tracer.scope().active()).to.equal(span)
                  done()
                })
              })

              connection.execBulkLoad(bulkLoad)
              rowStream.write([5], (err) => {
                if (err) done(err)
                rowStream.end()
              })
            })
          }
        })
      }
    })
  })
})
