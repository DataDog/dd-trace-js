const agent = require('../../dd-trace/test/plugins/agent')
const dc = require('dc-polyfill')

const clients = {
  pg: pg => pg.Client
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

describe('pg instrumentation', () => {
  withVersions('pg', 'pg', version => {
    const queryStartChannel = dc.channel('apm:pg:query:start')

    let pg
    let client
    let Query

    function abortQuery ({ abortController }) {
      const error = new Error('Test')
      abortController.abort(error)

      if (!abortController.signal.reason) {
        abortController.signal.reason = error
      }
    }

    before(() => {
      return agent.load(['pg'])
    })

    Object.keys(clients).forEach(implementation => {
      describe(implementation, () => {
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

        describe('pg.Client', () => {
          describe('abortController', () => {
            afterEach(() => {
              if (queryStartChannel.hasSubscribers) {
                queryStartChannel.unsubscribe(abortQuery)
              }
            })

            describe('using callback', () => {
              it('Should not fail if it is not aborted', (done) => {
                client.query('SELECT 1', (err) => {
                  client.end()
                  done(err)
                })
              })

              it('Should abort query', (done) => {
                queryStartChannel.subscribe(abortQuery)

                client.query('SELECT 1', (err) => {
                  client.end()
                  if (err && err.message === 'Test') {
                    return done()
                  }

                  done(new Error('Query was not aborted'))
                })
              })
            })

            describe('using promise', () => {
              it('Should not fail if it is not aborted', async () => {
                await client.query('SELECT 1')
                client.end()
              })

              it('Should abort query', async () => {
                queryStartChannel.subscribe(abortQuery)

                try {
                  await client.query('SELECT 1')

                  throw new Error('Query was not aborted')
                } catch (err) {
                  if (!err || err.message !== 'Test') {
                    throw err
                  }
                }
              })
            })

            describe('using query object', () => {
              describe('without callback', () => {
                it('Should not fail if it is not aborted', (done) => {
                  const query = new Query('SELECT 1')
                  client.query(query)

                  query.on('end', () => {
                    client.end()
                    done()
                  })
                })

                it('Should abort query', (done) => {
                  queryStartChannel.subscribe(abortQuery)
                  const query = new Query('SELECT 1')

                  client.query(query)

                  query.on('error', err => {
                    if (err && err.message === 'Test') {
                      done()
                      return
                    }
                    done(err || new Error('Query was not aborted'))
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
                  queryStartChannel.subscribe(abortQuery)
                  const query = new Query('SELECT 1')
                  query.callback = err => {
                    if (err && err.message === 'Test') {
                      done()
                      return
                    }

                    done(err || new Error('Query was not aborted'))
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
                  queryStartChannel.subscribe(abortQuery)
                  const query = new Query('SELECT 1')

                  client.query(query, err => {
                    if (err && err.message === 'Test') {
                      done()
                      return
                    }

                    done(err || new Error('Query was not aborted'))
                  })
                })
              })
            })
          })
        })
      })
    })
  })
})
