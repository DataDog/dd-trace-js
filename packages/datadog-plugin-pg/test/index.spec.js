'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const net = require('net')

const clients = {
  pg: pg => pg.Client
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

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
              host: '127.0.0.1',
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
              expect(traces[0][0].meta).to.have.property('component', 'pg')
              expect(traces[0][0].metrics).to.have.property('network.destination.port', 5432)

              if (implementation !== 'pg.native') {
                expect(traces[0][0].metrics).to.have.property('db.pid')
              }

              done()
            })

            client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should send long queries to agent', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('resource', `SELECT '${'x'.repeat(5000)}'::text as message`)

              done()
            })

            client.query(`SELECT '${'x'.repeat(5000)}'::text as message`, (err, result) => {
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
                expect(traces[0][0].meta).to.have.property('component', 'pg')
                expect(traces[0][0].metrics).to.have.property('network.destination.port', 5432)

                if (implementation !== 'pg.native') {
                  expect(traces[0][0].metrics).to.have.property('db.pid')
                }

                done()
              })

              client.query('SELECT $1::text as message', ['Hello world!'])
                .then(() => client.end())
                .catch(done)
            })
          }

          it('should handle errors', done => {
            let error

            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'pg')
              expect(traces[0][0].metrics).to.have.property('network.destination.port', 5432)

              done()
            })

            client.query('INVALID', (err, result) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should handle errors', done => {
            let error

            agent.use(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'pg')
              expect(traces[0][0].metrics).to.have.property('network.destination.port', 5432)

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
            host: '127.0.0.1',
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
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })

          client.connect(err => done(err))
        })

        it('should be configured with the correct service', done => {
          agent.use(traces => {
            try {
              expect(traces[0][0]).to.have.property('service', '127.0.0.1-postgres')

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
      describe('with DBM propagation enabled with service using plugin configurations', () => {
        before(() => {
          return agent.load('pg', [{ dbmPropagationMode: 'service', service: () => 'serviced' }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })
          client.connect(err => done(err))
        })

        it('should contain comment in query text', done => {
          const client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })

          client.connect(err => done(err))

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
          if (client.queryQueue[0] !== undefined) {
            try {
              expect(client.queryQueue[0].text).to.equal(
                `/*dddbs='serviced',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT $1::text as message`)
            } catch (e) {
              done(e)
            }
          }
        })
        it('trace query resource should not be changed when propagation is enabled', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
            done()
          })
          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) return done(err)
            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })
      describe('DBM propagation should handle special characters', () => {
        let clientDBM
        before(() => {
          return agent.load('pg', [{ dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })
        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          clientDBM = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })

          clientDBM.connect(err => done(err))
        })
        it('DBM propagation should handle special characters', done => {
          clientDBM.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) return done(err)

            clientDBM.end((err) => {
              if (err) return done(err)
            })
          })

          if (clientDBM.queryQueue[0] !== undefined) {
            try {
              expect(clientDBM.queryQueue[0].text).to.equal(
                `/*dddbs='~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E',dde='tester',` +
                `ddps='test',ddpv='8.4.0'*/ SELECT $1::text as message`)
              done()
            } catch (e) {
              done(e)
            }
          }
        })
      })
      describe('with DBM propagation enabled with full using tracer configurations', () => {
        const tracer = require('../../dd-trace')
        let seenTraceParent
        let seenTraceId
        let seenSpanId
        let originalWrite
        before(() => {
          return agent.load('pg')
        })
        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          tracer.init()
          tracer.use('pg', {
            dbmPropagationMode: 'full'
          })

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })
          client.connect(err => done(err))
          originalWrite = net.Socket.prototype.write
          net.Socket.prototype.write = function (buffer) {
            let strBuf = buffer.toString()
            if (strBuf.includes('traceparent=\'')) {
              strBuf = strBuf.split('-')
              seenTraceParent = true
              seenTraceId = strBuf[2]
              seenSpanId = strBuf[3]
            }
            return originalWrite.apply(this, arguments)
          }
        })
        afterEach(() => {
          net.Socket.prototype.write = originalWrite
        })
        it('query text should contain traceparent', done => {
          agent.use(traces => {
            const traceId = traces[0][0].trace_id.toString(16).padStart(32, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')
            expect(seenTraceId).to.equal(traceId)
            expect(seenSpanId).to.equal(spanId)
          }).then(done, done)

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)
            expect(seenTraceParent).to.be.true
            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('_dd.dbm_trace_injected', 'true')
            done()
          })

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
        it('service should default to tracer service name', done => {
          tracer
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'test-postgres')
            done()
          })

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })
      describe('DBM propagation enabled with full should handle prepared statements', () => {
        const tracer = require('../../dd-trace')

        before(() => {
          return agent.load('pg')
        })
        beforeEach(done => {
          pg = require('../../../versions/pg@>=8.0.3').get()

          tracer.init()
          tracer.use('pg', {
            dbmPropagationMode: 'full',
            service: 'post'
          })

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })
          client.connect(err => done(err))
        })

        it('prepared statements should be handled', done => {
          let queryText = ''
          const query = {
            text: 'SELECT $1::text as message'
          }
          agent.use(traces => {
            const traceId = traces[0][0].trace_id.toString(16).padStart(32, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            expect(queryText).to.equal(
              `/*dddbs='post',dde='tester',ddps='test',ddpv='8.4.0',` +
              `traceparent='00-${traceId}-${spanId}-00'*/ SELECT $1::text as message`)
          }).then(done, done)
          client.query(query, ['Hello world!'], (err) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
          queryText = client.queryQueue[0].text
        })
      })
    })
  })
})
