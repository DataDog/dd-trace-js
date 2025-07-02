'use strict'

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const hostname = process.env.CI ? 'oracledb' : 'localhost'
const port = '1521'
const dbInstance = 'xepdb1'

const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:${port}/${dbInstance}`
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

          withNamingSchema(
            () => connection.execute(dbQuery),
            rawExpectedSchema.outbound
          )

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            dbInstance,
            'db.instance'
          )

          connectionTests()
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

        function connectionTests () {
          it('should be instrumented for promise API', async () => {
            connection.execute(dbQuery)

            await agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: dbQuery,
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.hostname': hostname,
                'network.destination.port': port
              }
            })
          })

          it('should restore the parent context in the promise callback', () => {
            const span = {}
            return tracer.scope().activate(span, async () => {
              await connection.execute(dbQuery)
              expect(tracer.scope().active()).to.equal(span)
            })
          })

          it('should be instrumented for callback API', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: dbQuery,
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.hostname': hostname,
                'network.destination.port': port
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

          it('should instrument errors', async () => {
            let error
            let resolver
            const promise = new Promise((resolve) => {
              resolver = resolve
            })
            connection.execute('invalid', err => {
              error = err
              resolver()
            })

            await promise

            await agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'invalid',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.hostname': hostname,
                'network.destination.port': port,
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack
              }
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

          poolTests()

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            dbInstance,
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

        function poolTests () {
          it('should be instrumented correctly with correct tags', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: dbQuery,
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'oracledb',
                  'db.instance': dbInstance,
                  'db.hostname': hostname,
                  'network.destination.port': port
                }
              }),
              connection.execute(dbQuery)
            ])
          })

          it('should restore the parent context in the callback', async () => {
            await connection.execute(dbQuery)
            expect(tracer.scope().active()).to.be.null
          })

          it('should instrument errors', async () => {
            try {
              await connection.execute('invalid')
              throw new Error('Expected an error to be thrown')
            } catch (error) {
              await agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'invalid',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'oracledb',
                  'db.instance': dbInstance,
                  'db.hostname': hostname,
                  'network.destination.port': port,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_TYPE]: error.name,
                  [ERROR_STACK]: error.stack
                }
              })
            }
          })
        }
      })

      describe('with configuration', () => {
        describe('with service string', () => {
          before(async () => {
            await agent.load('oracledb', { service () {} })
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
                serviceName: config.connectString
              },
              v1: {
                opName: 'oracle.query',
                serviceName: config.connectString
              }
            }
          )

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: config.connectString
              }),
              connection.execute(dbQuery)
            ])
          })
        })

        describe('with service returning undefined', () => {
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

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: 'custom'
              }),
              connection.execute(dbQuery)
            ])
          })
        })

        describe('with service function', () => {
          before(async () => {
            await agent.load('oracledb', { service: connAttrs => connAttrs.connectString })
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
                serviceName: config.connectString,
              },
              v1: {
                opName: 'oracle.query',
                serviceName: config.connectString,
              }
            }
          )

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: config.connectString
              }),
              connection.execute(dbQuery)
            ])
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

            await Promise.all([
              agent.assertFirstTraceSpan({
                service: config.connectString
              }),
              connection.execute(dbQuery)
            ])
            await connection.close()
          })
        })
      })
    })
  })
})
