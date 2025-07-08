'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const dc = require('dc-polyfill')
const { assert } = require('chai')

const clients = {
  pg: pg => pg.Client
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

describe('pg instrumentation', () => {
  withVersions('pg', 'pg', version => {
    const queryClientStartChannel = dc.channel('apm:pg:query:start')
    const queryPoolStartChannel = dc.channel('datadog:pg:pool:query:start')

    let pg
    let Query

    function abortQuery ({ abortController }) {
      const error = new Error('Test')
      abortController.abort(error)
    }

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
              application_name: 'test'
            })

            client.connect(err => done(err))
          })

          afterEach(() => {
            client.end()
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
                  assert.propertyVal(err, 'message', 'Test')
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
                  assert.propertyVal(err, 'message', 'Test')

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

                  client.query(query)

                  query.on('error', err => {
                    assert.propertyVal(err, 'message', 'Test')
                    done()
                  })

                  query.on('end', () => {
                    done(new Error('Query was not aborted'))
                  })
                })
              })

              describe('with callback in query object', () => {
                it('Should not fail if it is not aborted', (done) => {
                  const query = new Query('SELECT 1')
                  query.callback = (err) => {
                    done(err)
                  }

                  client.query(query)
                })

                it('Should abort query', (done) => {
                  queryClientStartChannel.subscribe(abortQuery)

                  const query = new Query('SELECT 1')
                  query.callback = err => {
                    assert.propertyVal(err, 'message', 'Test')
                    done()
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
                    assert.propertyVal(err, 'message', 'Test')
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
          application_name: 'test'
        })
      })

      describe('abortController', () => {
        afterEach(() => {
          if (queryPoolStartChannel.hasSubscribers) {
            queryPoolStartChannel.unsubscribe(abortQuery)
          }
        })

        describe('using callback', () => {
          it('Should not fail if it is not aborted', (done) => {
            pool.query('SELECT 1', (err) => {
              done(err)
            })
          })

          it('Should abort query', (done) => {
            queryPoolStartChannel.subscribe(abortQuery)

            pool.query('SELECT 1', (err) => {
              assert.propertyVal(err, 'message', 'Test')
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
              assert.propertyVal(err, 'message', 'Test')
              return
            }

            throw new Error('Query was not aborted')
          })
        })
      })
    })
  })
})
