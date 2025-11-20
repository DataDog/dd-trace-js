'use strict'
const assert = require('node:assert')
const EventEmitter = require('node:events')
const net = require('node:net')

const semver = require('semver')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const ddpv = require('mocha/package.json').version

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

          withPeerService(
            () => tracer,
            'pg',
            (done) => client.query('SELECT 1', done),
            'postgres',
            'db.name'
          )

          it('should do automatic instrumentation when using callbacks', done => {
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
              assert.strictEqual(traces[0][0].type, 'sql')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['db.name'], 'postgres')
              assert.strictEqual(traces[0][0].meta['db.user'], 'postgres')
              assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
              assert.strictEqual(traces[0][0].meta.component, 'pg')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'pg')
              assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)

              if (implementation !== 'pg.native') {
                assert.ok(Object.hasOwn(traces[0][0].metrics, 'db.pid'))
              }
            })
              .then(done)
              .catch(done)

            client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should send long queries to agent', done => {
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, `SELECT '${'x'.repeat(5000)}'::text as message`)

              done()
            })

            client.query(`SELECT '${'x'.repeat(5000)}'::text as message`, (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          if (semver.intersects(version, '>=5.1')) {
            // initial promise support
            it('should do automatic instrumentation when using promises', done => {
              agent.assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
                assert.strictEqual(traces[0][0].type, 'sql')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['db.name'], 'postgres')
                assert.strictEqual(traces[0][0].meta['db.user'], 'postgres')
                assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
                assert.strictEqual(traces[0][0].meta.component, 'pg')
                assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)

                if (implementation !== 'pg.native') {
                  assert.ok(Object.hasOwn(traces[0][0].metrics, 'db.pid'))
                }
              })
                .then(done)
                .catch(done)

              client.query('SELECT $1::text as message', ['Hello world!'])
                .then(() => client.end())
                .catch(done)
            })
          }

          it('should handle callback errors', done => {
            let error

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][0].meta.component, 'pg')
              assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)
            })
              .then(done)
              .catch(done)

            client.query('INVALID', (err, result) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should handle event emitter errors', done => {
            let error

            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)

              // pg modifies stacktraces as of v8.11.1
              const actualErrorNoStack = traces[0][0].meta[ERROR_STACK].split('\n')[0]
              const expectedErrorNoStack = error.stack.split('\n')[0]
              assert.deepStrictEqual(actualErrorNoStack, expectedErrorNoStack)

              assert.strictEqual(traces[0][0].meta.component, 'pg')
              assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)
            })
              .then(done)
              .catch(done)

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
                assert.strictEqual(tracer.scope().active(), span)
                done()
              })

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          withNamingSchema(
            done => client.query('SELECT $1::text as message', ['Hello world!'])
              .then(() => client.end())
              .catch(done),
            rawExpectedSchema.outbound
          )

          if (implementation !== 'pg.native') {
            // pg-cursor is not supported on pg.native, pg-query-stream uses pg-cursor so it is also unsupported
            describe('streaming capabilities', () => {
              withVersions('pg', 'pg-cursor', pgCursorVersion => {
                let Cursor

                beforeEach(() => {
                  Cursor = require(`../../../versions/pg-cursor@${pgCursorVersion}`).get()
                })

                it('should instrument cursor-based streaming with pg-cursor', async () => {
                  const tracingPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                    assert.strictEqual(traces[0][0].meta['db.name'], 'postgres')
                    assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
                    assert.strictEqual(traces[0][0].meta.component, 'pg')
                    assert.strictEqual(traces[0][0].metrics['db.stream'], 1)
                    assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)
                  })

                  const cursor = client.query(new Cursor('SELECT * FROM generate_series(0, 1) num'))

                  cursor.read(1, () => {
                    cursor.close()
                  })
                  await tracingPromise
                })
              })

              withVersions('pg', 'pg-query-stream', pgQueryStreamVersion => {
                let QueryStream

                beforeEach(() => {
                  QueryStream = require(`../../../versions/pg-query-stream@${pgQueryStreamVersion}`).get()
                })

                it('should instrument stream-based queries with pg-query-stream', async () => {
                  const agentPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assert.strictEqual(traces[0][0].error, 0)
                    assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                    assert.strictEqual(traces[0][0].meta['db.name'], 'postgres')
                    assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
                    assert.strictEqual(traces[0][0].meta.component, 'pg')
                    assert.strictEqual(traces[0][0].metrics['db.stream'], 1)
                    assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)
                  })

                  const query = new QueryStream('SELECT * FROM generate_series(0, 1) num', [])
                  const stream = client.query(query)

                  assert.strictEqual(stream.listenerCount('error'), 0)

                  const readPromise = (async () => {
                    for await (const row of stream) {
                      assert.ok(Object.hasOwn(row, 'num'))
                    }
                  })()

                  await Promise.all([readPromise, agentPromise])
                })

                it('should instrument stream-based queries with pg-query-stream and catch errors', async () => {
                  const agentPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assert.strictEqual(traces[0][0].error, 1)
                    assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                    assert.strictEqual(traces[0][0].meta['db.name'], 'postgres')
                    assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
                    assert.strictEqual(traces[0][0].meta.component, 'pg')
                    assert.strictEqual(traces[0][0].metrics['db.stream'], 1)
                    assert.strictEqual(traces[0][0].metrics['network.destination.port'], 5432)
                  })

                  const query = new QueryStream('SELECT * FROM generate_series(0, 1) num', [])
                  const stream = client.query(query)

                  assert.strictEqual(stream.listenerCount('error'), 0)

                  const rejectedRead = assert.rejects(async () => {
                    // eslint-disable-next-line no-unreachable-loop
                    for await (const row of stream) {
                      assert.ok(Object.hasOwn(row, 'num'))
                      throw new Error('Test error')
                    }
                  }, {
                    message: 'Test error'
                  })

                  await Promise.all([rejectedRead, agentPromise])
                })
              })
            })
          }
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('pg', { service: 'custom', truncate: 12 })
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
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, 'custom')
            assert.strictEqual(traces[0][0].resource, 'SELECT $1...')
          })
            .then(done)
            .catch(done)

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })

        withNamingSchema(
          done => client.query('SELECT $1::text as message', ['Hello world!'])
            .then(() => client.end())
            .catch(done),
          {
            v0: {
              opName: 'pg.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'postgresql.query',
              serviceName: 'custom'
            }
          }
        )
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
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, '127.0.0.1-postgres')
          })
            .then(done)
            .catch(done)

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })

        withNamingSchema(
          done => client.query('SELECT $1::text as message', ['Hello world!'])
            .then(() => client.end())
            .catch(done),
          {
            v0: {
              opName: 'pg.query',
              serviceName: '127.0.0.1-postgres'
            },
            v1: {
              opName: 'postgresql.query',
              serviceName: '127.0.0.1-postgres'
            }
          }
        )
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        before(() => {
          return agent.load('pg', { dbmPropagationMode: 'service', service: () => 'serviced' })
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
              assert.strictEqual(client.queryQueue[0].text,
                '/*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT $1::text as message`)
            } catch (e) {
              done(e)
            }
          }
        })

        it('trace query resource should not be changed when propagation is enabled', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
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
          return agent.load('pg', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
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
              assert.strictEqual(clientDBM.queryQueue[0].text,
                '/*dddb=\'postgres\',dddbs=\'~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E\',dde=\'tester\',' +
                `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/ SELECT $1::text as message`)
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
        const originalWrite = net.Socket.prototype.write

        before(() => {
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
        })

        after(() => {
          net.Socket.prototype.write = originalWrite
        })

        it('query text should contain traceparent', done => {
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')
            assert.strictEqual(seenTraceId, traceId)
            assert.strictEqual(seenSpanId, spanId)
          }).then(done, done)

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)
            assert.strictEqual(seenTraceParent, true)
            client.end((err) => {
              if (err) return done(err)
            })
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.dbm_trace_injected'], 'true')
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
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
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

      describe('DBM propagation enabled with full should handle query config objects', () => {
        const tracer = require('../../dd-trace')

        before(() => {
          return agent.load('pg')
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

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

        afterEach((done) => {
          client.end(done)

          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        it('query config objects should be handled', async () => {
          const query = {
            text: 'SELECT $1::text as message'
          }

          const queryPromise = client.query(query, ['Hello world!'])
          const queryText = client.queryQueue[0].text

          await queryPromise

          await agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
              `traceparent='00-${traceId}-${spanId}-01'*/ SELECT $1::text as message`)
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', async () => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          const query = {
            text: 'SELECT $1::text as message'
          }

          const queryPromise = client.query(query, ['Hello world!'])
          const queryText = client.queryQueue[0].text

          await queryPromise

          await agent.assertSomeTraces(() => {
            assert.match(queryText, /-00'\*\/ SELECT \$1::text as message/)
          })
        })

        it('query config object should persist when comment is injected', done => {
          const query = {
            name: 'pgSelectQuery',
            text: 'SELECT $1::text as message'
          }

          client.query(query, ['Hello world!'], (err) => {
            done(err)
          })

          assert.strictEqual(query.name, 'pgSelectQuery')
        })

        it('falls back to service with prepared statements', done => {
          const query = {
            name: 'pgSelectQuery',
            text: 'SELECT $1::text as message'
          }

          client.query(query, ['Hello world!'], (err) => {
            done(err)
          })
          assert.strictEqual(client.queryQueue[0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message'
          )
        })

        it('should not fail when using query object with getters', done => {
          const query = {
            name: 'pgSelectQuery',
            get text () { return 'SELECT $1::text as message' }
          }

          client.query(query, ['Hello world!'], async (err) => {
            done(err)
          })
          assert.strictEqual(client.queryQueue[0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message')
        })

        it('should not fail when using query object that is an EventEmitter', done => {
          class Query extends EventEmitter {
            constructor (name, text) {
              super()
              this.name = name
              this._internalText = text
            }

            get text () {
              assert.deepStrictEqual(typeof this.on, 'function')
              return this._internalText
            }
          }

          const query = new Query('pgSelectQuery', 'SELECT $1::text as greeting')

          client.query(query, ['Goodbye'], (err) => {
            done(err)
          })
          assert.strictEqual(client.queryQueue[0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as greeting')
        })
      })

      describe('with DBM propagation enabled with append comment configurations', () => {
        before(async () => {
          await agent.load('pg', {
            appendComment: true,
            dbmPropagationMode: 'service',
            service: () => 'serviced',
          })
          pg = require(`../../../versions/pg@${version}`).get()
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach((done) => {
          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
          })
          client.connect(err => done(err))
        })

        afterEach((done) => {
          client.end(done)
        })

        it('should append comment in query text', async () => {
          const queryPromise = client.query('SELECT $1::text as message', ['Hello world!'])

          assert.strictEqual(client.queryQueue[0].text,
            'SELECT $1::text as message /*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',' +
              `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/`
          )

          await queryPromise
        })
      })
    })
  })
})
