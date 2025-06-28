'use strict'

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const hostname = process.env.CI ? 'oracledb' : 'localhost'
const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:1521/xepdb1`
}
const expectedPeerService = new URL('http://' + config.connectString).pathname.slice(1)

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

          withNamingSchema(
            () => connection.execute(dbQuery),
            rawExpectedSchema.outbound
          )

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            expectedPeerService,
            'db.instance'
          )

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
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('network.destination.port', url.port)
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
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('network.destination.port', url.port)
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

            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'invalid')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('network.destination.port', url.port)
              }
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
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

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            expectedPeerService,
            'db.instance'
          )
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
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('network.destination.port', url.port)
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

            const promise = agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'invalid')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('component', 'oracledb')
              if (url) {
                expect(traces[0][0].meta).to.have.property('db.instance', url.pathname.slice(1))
                expect(traces[0][0].meta).to.have.property('db.hostname', url.hostname)
                expect(traces[0][0].meta).to.have.property('network.destination.port', url.port)
              }
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
            })

            connection.execute('invalid').catch(err => {
              error = err
            })

            return promise
          })
        }
      })

      describe('with configuration', () => {
        describe('with service string', () => {
          before(async () => {
            await agent.load('oracledb', { service: 'custom' })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          after(async () => {
            await agent.close({ ritmReset: false })
          })
          withNamingSchema(
            () => connection.execute(dbQuery),
            {
              v0: {
                opName: 'oracle.query',
                serviceName: 'custom'
              },
              v1: {
                opName: 'oracle.query',
                serviceName: 'custom'
              }
            }
          )

          it('should set the service name', done => {
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', 'custom')
            }).then(done, done)
            connection.execute(dbQuery)
          })
        })

        describe('with service function', () => {
          before(async () => {
            await agent.load('oracledb', { service: connAttrs => `${connAttrs.connectString}` })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          after(async () => {
            await agent.close({ ritmReset: false })
          })
          withNamingSchema(
            () => connection.execute(dbQuery),
            {
              v0: {
                opName: 'oracle.query',
                serviceName: 'oracledb:1521/xepdb1'
              },
              v1: {
                opName: 'oracle.query',
                serviceName: 'oracledb:1521/xepdb1'
              }
            }
          )

          it('should set the service name', done => {
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', config.connectString)
            }).then(done, done)
            connection.execute(dbQuery)
          })
        })

        describe('with connectionString fallback', () => {
          before(async () => {
            await agent.load('oracledb', {
              service: connAttrs => connAttrs.connectString || connAttrs.connectionString
            })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          after(async () => {
            await agent.close({ ritmReset: false })
          })

          it('should fallback to connectionString when connectString is not available', async () => {
            const connection = await oracledb.getConnection({
              user: config.user,
              password: config.password,
              connectionString: config.connectString // Use valid connection string
            })

            const promise = agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', config.connectString)
            })

            connection.execute(dbQuery)
            await connection.close()
            return promise
          })
        })
      })
    })
  })
})
