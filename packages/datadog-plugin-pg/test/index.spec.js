'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')

const clients = {
  pg: pg => pg.Client
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let pg
  let client
  let tracer

  describe('pg', () => {
    withVersions('pg', 'pg', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      Object.keys(clients).forEach(implementation => {
        describe(`when using ${implementation}.Client`, () => {
          before(() => {
            return agent.load('pg')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(done => {
            pg = require(`../../../versions/pg@${version}`).get()

            const Client = clients[implementation](pg)

            client = new Client({
              user: 'postgres',
              password: 'postgres',
              database: 'postgres',
              application_name: 'test'
            })

            client.connect(err => done(err))
          })

          it('should do automatic instrumentation when using callbacks', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-postgres')
              expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
              expect(traces[0][0]).to.have.property('type', 'sql')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('db.name', 'postgres')
              expect(traces[0][0].meta).to.have.property('db.user', 'postgres')
              expect(traces[0][0].meta).to.have.property('db.type', 'postgres')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')

              done()
            })

            client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          if (semver.intersects(version, '>=5.1')) { // initial promise support
            it('should do automatic instrumentation when using promises', done => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-postgres')
                expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
                expect(traces[0][0]).to.have.property('type', 'sql')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('db.name', 'postgres')
                expect(traces[0][0].meta).to.have.property('db.user', 'postgres')
                expect(traces[0][0].meta).to.have.property('db.type', 'postgres')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')

                done()
              })

              client.query('SELECT $1::text as message', ['Hello world!'])
                .then(() => client.end())
                .catch(done)
            })
          }

          it('should handle callback query errors', done => {
            let error

            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)

              done()
            })

            client.query('INVALID', (err, result) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should handle async query errors', done => {
            let error

            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)

              done()
            })

            const errorCallback = (err) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            }
            const query = client.query('INVALID')
            if (query.on) {
              query.on('error', errorCallback)
            } else {
              query.catch(errorCallback)
            }
          })

          it('should run the callback in the parent context', done => {
            const span = {}

            tracer.scope().activate(span, () => {
              const span = tracer.scope().active()

              client.query('SELECT $1::text as message', ['Hello World!'], () => {
                expect(tracer.scope().active()).to.equal(span)
                done()
              })

              client.end((err) => {
                if (err) throw err
              })
            })
          })
        })

        describe(`connection errors when using ${implementation}.Client`, () => {
          before(() => {
            return agent.load('pg')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach((done) => {
            pg = require(`../../../versions/pg@${version}`).get()

            const Client = clients[implementation](pg)

            client = new Client({
              user: 'invalid',
              password: 'invalid',
              database: 'invalid',
              application_name: 'test'
            })

            done()
          })

          it('should handle connection errors for callbacks', (done) => {
            let error
            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            }).then(done, done)

            client.connect((err) => {
              error = err
            })
          })

          if (semver.intersects(version, '>=5.1')) { // initial promise support
            it('should handle connection errors for promises', async () => {
              let error

              const promise = agent.use(traces => {
                expect(traces[0][0].meta).to.have.property('error.type', error.name)
                expect(traces[0][0].meta).to.have.property('error.msg', error.message)
                expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
              })

              try {
                await client.connect()
              } catch (err) {
                error = err
              }

              await promise
            })
          }
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('pg', { service: 'custom' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })

          client.connect(err => done(err))
        })

        it('should be configured with the correct values', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')

            done()
          })

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })
      })

      describe('with a service name callback', () => {
        before(() => {
          return agent.load('pg', { service: params => `${params.host}-${params.database}` })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })

          client.connect(err => done(err))
        })

        it('should be configured with the correct service', done => {
          agent.use(traces => {
            try {
              expect(traces[0][0]).to.have.property('service', 'localhost-postgres')

              done()
            } catch (e) {
              done(e)
            }
          })

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })
      })

      // internal pooling code was replaced with pg-pool in 6.0
      if (semver.intersects(version, '>=6')) {
        describe('with a connection pool', () => {
          let pg
          let pool

          before(async () => {
            await agent.load('pg')
            pg = require(`../../../versions/pg@${version}`).get()
          })

          beforeEach(async () => {
            pool = new pg.Pool({
              user: 'postgres',
              password: 'postgres',
              database: 'postgres',
              application_name: 'test',
              max: 20,
              idleTimeoutMillis: 30000,
              connectionTimeoutMillis: 2000
            })
          })

          afterEach(async () => {
            await pool && pool.end()
            pool = undefined
          })

          after(async () => {
            await agent.close({ ritmReset: false })
          })

          it('should be configured with the correct values for callbacks', done => {
            agent.use(traces => {
              // connect spans from the pool and client come first
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('service', 'test-postgres')
              expect(spans[0]).to.have.property('name', 'pg-pool.connect')
              expect(spans[0]).to.have.property('resource', 'pg-pool.connect')
              expect(spans[0]).to.have.property('type', 'sql')
              expect(spans[0].meta).to.have.property('span.kind', 'client')
              expect(spans[0].meta).to.have.property('db.type', 'postgres')
              expect(spans[0].metrics).to.have.property('db.pool.clients.max', 20)
              expect(spans[0].metrics).to.have.property('db.pool.clients.idle_timeout_millis', 30000)
              expect(spans[0].metrics).to.have.property('db.pool.clients.idle', 0)
              expect(spans[0].metrics).to.have.property('db.pool.clients.total', 0)
              expect(spans[0].metrics).to.have.property('db.pool.queries.pending', 0)

              expect(spans[1]).to.have.property('service', 'test-postgres')
              expect(spans[1]).to.have.property('name', 'pg.connect')
              expect(spans[1]).to.have.property('resource', 'pg.connect')
              expect(spans[1]).to.have.property('type', 'sql')
              expect(spans[1].meta).to.have.property('span.kind', 'client')
              expect(spans[1].meta).to.have.property('db.type', 'postgres')
              expect(spans[1].meta).to.have.property('db.name', 'postgres')
              expect(spans[1].meta).to.have.property('db.user', 'postgres')
            }).then(() => {
              return agent.use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-postgres')
                expect(traces[0][0]).to.have.property('name', 'pg.query')
                expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
                expect(traces[0][0]).to.have.property('type', 'sql')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('db.name', 'postgres')
                expect(traces[0][0].meta).to.have.property('db.user', 'postgres')
                expect(traces[0][0].meta).to.have.property('db.type', 'postgres')
              })
            }).then(done, done)

            pool.query('SELECT $1::text as message', ['Hello world!'], (err) => {
              if (err) throw err
            })
          })

          it('should be configured with the correct values for promises', async () => {
            pool.query('SELECT $1::text as message', ['Hello world!']).catch(err => { throw err })

            await agent.use(traces => {
              // connect spans from the pool and client come first
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('name', 'pg-pool.connect')
              expect(spans[0].metrics).to.have.property('db.pool.clients.max', 20)
              expect(spans[0].metrics).to.have.property('db.pool.clients.idle', 0)
              expect(spans[0].metrics).to.have.property('db.pool.clients.total', 0)
              expect(spans[0].metrics).to.have.property('db.pool.queries.pending', 0)

              expect(spans[1]).to.have.property('name', 'pg.connect')
            })

            await agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'pg.query')
            })
          })

          it('should allow for manual connection calls', async () => {
            const promise = agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'pg-pool.connect')
            })

            const client = await pool.connect()
            await client.query('SELECT NOW()')
            await promise
          })
        })

        describe('connection errors for connection pool', () => {
          let pg
          let pool

          before(async () => {
            await agent.load('pg')
            pg = require(`../../../versions/pg@${version}`).get()
          })

          beforeEach((done) => {
            pool = new pg.Pool({
              user: 'invalid',
              password: 'invalid',
              database: 'invalid',
              application_name: 'test'
            })

            done()
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          it('should handle connection errors for callbacks', done => {
            let error
            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            }).then(done, done)

            pool.connect((err) => {
              error = err
            })
          })

          it('should handle connection errors for promises', async () => {
            let error

            const promise = agent.use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })

            try {
              await pool.connect()
            } catch (err) {
              error = err
            }

            await promise
          })
        })
      }
    })
  })
})
