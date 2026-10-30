'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const clients = {
  pg: pg => pg.Client,
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

describe('pg instrumentation', () => {
  withVersions('pg', 'pg', version => {
    const queryClientStartChannel = dc.channel('apm:pg:query:start')
    const spanFinishChannel = dc.channel('dd-trace:span:finish')
    const queryPoolStartChannel = dc.channel('datadog:pg:pool:query:start')
    const poolAcquireStartChannel = dc.channel('apm:pg:pool:acquire:start')

    let pg
    let Query

    function abortQuery ({ abortController }) {
      const error = new Error('Test')
      abortController.abort(error)
    }

    function observeQuery () {}

    before(() => {
      return agent.load(['pg'])
    })

    describe('pg.Client', () => {
      Object.keys(clients).forEach(implementation => {
        describe(implementation, () => {
          let client

          beforeEach(done => {
            pg = require(`../../../versions/pg@${version}`).get()
            const Client = clients[implementation](pg)
            Query = Client.Query

            client = new Client({
              host: '127.0.0.1',
              user: 'postgres',
              password: 'postgres',
              database: 'postgres',
              application_name: 'test',
            })

            client.connect(err => done(err))
          })

          afterEach(() => {
            client.end()
          })

          describe('pipeline mode', () => {
            let finished

            /**
             * @param {import('../../dd-trace/src/opentracing/span')} span
             */
            function onFinish (span) {
              if (span._name !== 'pg.query') return
              const context = span.context()
              finished.push({ text: context.getTag('resource.name'), error: context.getTag('error')?.message })
            }

            beforeEach(function () {
              if (implementation !== 'pg' || !Object.hasOwn(client, '_sentQueryQueue')) {
                // Older pg releases and the native client do not have the JavaScript pipeline queue.
                this.skip()
              }
              client.pipeline = true
              finished = []
              spanFinishChannel.subscribe(onFinish)
            })

            afterEach(() => {
              spanFinishChannel.unsubscribe(onFinish)
            })

            it('finishes each promise query when its own result arrives', async () => {
              const results = await Promise.all([1, 2, 3].map(value => client.query(`SELECT ${value} AS value`)))

              assert.deepStrictEqual(results.map(result => result.rows), [
                [{ value: 1 }], [{ value: 2 }], [{ value: 3 }],
              ])
              assert.deepStrictEqual(finished, [1, 2, 3].map(value => ({
                text: `SELECT ${value} AS value`, error: undefined,
              })))
            })

            it('finishes each callback query before invoking its callback in the parent context', async () => {
              const tracer = require('../../dd-trace')

              await Promise.all([1, 2, 3].map(value => tracer.trace(`parent-${value}`, () => {
                const parent = tracer.scope().active()
                return new Promise((resolve, reject) => {
                  client.query(`SELECT ${value} AS value`, (error, result) => {
                    if (error) return reject(error)
                    try {
                      assert.strictEqual(tracer.scope().active(), parent)
                      assert.deepStrictEqual(result.rows, [{ value }])
                      assert.deepStrictEqual(finished.map(query => query.text),
                        Array.from({ length: value }, (_, i) => `SELECT ${i + 1} AS value`))
                      resolve()
                    } catch (error) {
                      reject(error)
                    }
                  })
                })
              })))
            })

            it('finishes each query object when its own end event fires', async () => {
              await Promise.all([1, 2, 3].map(value => new Promise((resolve, reject) => {
                const query = new Query(`SELECT ${value} AS value`)
                query.once('error', reject)
                client.query(query).once('end', result => {
                  try {
                    assert.deepStrictEqual(result.rows, [{ value }])
                    assert.deepStrictEqual(finished.map(query => query.text),
                      Array.from({ length: value }, (_, i) => `SELECT ${i + 1} AS value`))
                    resolve()
                  } catch (error) {
                    reject(error)
                  }
                })
              })))
            })

            it('attributes a server error to the failing query and continues the pipeline', async () => {
              await Promise.all([
                client.query('SELECT 1 AS value'),
                assert.rejects(client.query('INVALID'), { code: '42601' }),
                client.query('SELECT 3 AS value'),
              ])

              assert.deepStrictEqual(finished, [
                { text: 'SELECT 1 AS value', error: undefined },
                { text: 'INVALID', error: 'syntax error at or near "INVALID"' },
                { text: 'SELECT 3 AS value', error: undefined },
              ])
            })

            it('finishes an errored query object without finishing the following query', async () => {
              const first = client.query('SELECT 1 AS value')
              const failure = new Promise((resolve, reject) => {
                const query = new Query('INVALID')
                query.once('error', reject)
                query.once('end', resolve)
                client.query(query)
              })

              await Promise.all([
                first,
                assert.rejects(failure, { code: '42601' }),
                client.query('SELECT 3 AS value'),
              ])

              assert.deepStrictEqual(finished, [
                { text: 'SELECT 1 AS value', error: undefined },
                { text: 'INVALID', error: 'syntax error at or near "INVALID"' },
                { text: 'SELECT 3 AS value', error: undefined },
              ])
            })
          })

          describe('abortController', () => {
            afterEach(() => {
              if (queryClientStartChannel.hasSubscribers) {
                queryClientStartChannel.unsubscribe(abortQuery)
              }
            })

            describe('using callback', () => {
              it('Should not fail if it is not aborted', (done) => {
                client.query('SELECT 1', (err) => {
                  done(err)
                })
              })

              it('Should abort query', (done) => {
                queryClientStartChannel.subscribe(abortQuery)

                client.query('SELECT 1', (err) => {
                  assert.strictEqual(err.message, 'Test')
                  done()
                })
              })
            })

            describe('using promise', () => {
              it('Should not fail if it is not aborted', async () => {
                await client.query('SELECT 1')
              })

              it('Should abort query', async () => {
                queryClientStartChannel.subscribe(abortQuery)

                try {
                  await client.query('SELECT 1')
                } catch (err) {
                  assert.strictEqual(err.message, 'Test')

                  return
                }

                throw new Error('Query was not aborted')
              })
            })

            describe('using query object', () => {
              describe('without callback', () => {
                it('Should not fail if it is not aborted', (done) => {
                  const query = new Query('SELECT 1')

                  client.query(query)

                  query.on('end', () => {
                    done()
                  })
                })

                it('Should abort query', (done) => {
                  queryClientStartChannel.subscribe(abortQuery)

                  const query = new Query('SELECT 1')

                  query.on('error', error => {
                    try {
                      assert.strictEqual(error.message, 'Test')
                      done()
                    } catch (error) {
                      done(error)
                    }
                  })

                  query.on('end', () => {
                    done(new Error('Query was not aborted'))
                  })

                  client.query(query)
                })
              })

              describe('with callback in query object', () => {
                // eslint-disable-next-line mocha/handle-done-callback -- Query invokes the assigned callback.
                it('Should not fail if it is not aborted', (done) => {
                  const query = new Query('SELECT 1')
                  query.callback = (error) => {
                    done(error)
                  }

                  client.query(query)
                })

                // eslint-disable-next-line mocha/handle-done-callback -- Query invokes the assigned callback.
                it('Should abort query', (done) => {
                  queryClientStartChannel.subscribe(abortQuery)

                  const query = new Query('SELECT 1')
                  query.callback = error => {
                    try {
                      assert.strictEqual(error.message, 'Test')
                      done()
                    } catch (error) {
                      done(error)
                    }
                  }

                  client.query(query)
                })
              })

              describe('with callback in query parameter', () => {
                it('Should not fail if it is not aborted', (done) => {
                  const query = new Query('SELECT 1')

                  client.query(query, (err) => {
                    done(err)
                  })
                })

                it('Should abort query', (done) => {
                  queryClientStartChannel.subscribe(abortQuery)

                  const query = new Query('SELECT 1')

                  client.query(query, err => {
                    assert.strictEqual(err.message, 'Test')
                    done()
                  })
                })
              })
            })
          })
        })
      })
    })

    describe('pg.Pool', () => {
      let pool

      beforeEach(() => {
        const { Pool } = require(`../../../versions/pg@${version}`).get()

        pool = new Pool({
          host: '127.0.0.1',
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test',
        })
      })

      it('dispatches connect before query returns', async () => {
        const connect = pool.connect
        let queryReturned = false
        let connectDispatchedBeforeReturn = false

        /**
         * @param {...unknown} args
         * @returns {unknown}
         */
        pool.connect = function (...args) {
          if (!queryReturned) connectDispatchedBeforeReturn = true
          return connect.apply(this, args)
        }

        try {
          const query = pool.query('SELECT 1')
          queryReturned = true

          await query

          assert.strictEqual(connectDispatchedBeforeReturn, true)
        } finally {
          pool.connect = connect
        }
      })

      it('treats a callback connect reentered from a synchronous pool hook as explicit', async () => {
        let acquireStarts = 0
        let nestedConnect
        let reentered = false
        const onAcquireStart = () => { acquireStarts++ }
        const { Pool } = require(`../../../versions/pg@${version}`).get()
        const reentrantPool = new Pool({
          host: '127.0.0.1',
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test',
          max: 1,
          log (message) {
            if (message !== 'checking client timeout' || reentered) return
            reentered = true
            nestedConnect = new Promise((resolve, reject) => {
              reentrantPool.connect((error, client, release) => {
                if (error) return reject(error)
                release()
                resolve()
              })
            })
          },
        })
        poolAcquireStartChannel.subscribe(onAcquireStart)

        try {
          await reentrantPool.query('SELECT 1')
          await nestedConnect

          assert.strictEqual(acquireStarts, 1)
        } finally {
          poolAcquireStartChannel.unsubscribe(onAcquireStart)
          await reentrantPool.end()
        }
      })

      it('carries the pool wait when query dispatch is deferred after connect', async () => {
        let queryContext
        const connect = pool.connect

        /**
         * @param {object} context
         */
        function observeQueryStart (context) {
          queryContext = context
        }

        /**
         * @param {Function} callback
         */
        pool.connect = function (callback) {
          /**
           * @param {...unknown} args
           */
          const deferCallback = (...args) => {
            setImmediate(() => callback(...args))
          }
          return connect.call(this, deferCallback)
        }
        queryClientStartChannel.subscribe(observeQueryStart)

        try {
          await pool.query('SELECT 1')

          assert.strictEqual(typeof queryContext.poolWaitTime, 'number')
        } finally {
          pool.connect = connect
          queryClientStartChannel.unsubscribe(observeQueryStart)
        }
      })

      describe('abortController', () => {
        afterEach(() => {
          if (queryPoolStartChannel.hasSubscribers) {
            queryPoolStartChannel.unsubscribe(abortQuery)
            queryPoolStartChannel.unsubscribe(observeQuery)
          }
        })

        describe('using callback', () => {
          it('Should not fail if it is not aborted', (done) => {
            pool.query('SELECT 1', (err) => {
              done(err)
            })
          })

          it('Should run the query when a subscriber does not abort it', (done) => {
            queryPoolStartChannel.subscribe(observeQuery)

            pool.query('SELECT 1', (err) => {
              done(err)
            })
          })

          it('Should abort query', (done) => {
            queryPoolStartChannel.subscribe(abortQuery)

            pool.query('SELECT 1', (err) => {
              assert.strictEqual(err.message, 'Test')
              done()
            })
          })
        })

        describe('using promise', () => {
          it('Should not fail if it is not aborted', async () => {
            await pool.query('SELECT 1')
          })

          it('Should abort query', async () => {
            queryPoolStartChannel.subscribe(abortQuery)

            try {
              await pool.query('SELECT 1')
            } catch (err) {
              assert.strictEqual(err.message, 'Test')
              return
            }

            throw new Error('Query was not aborted')
          })
        })
      })
    })
  })
})
