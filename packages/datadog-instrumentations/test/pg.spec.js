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

      // afterEach((done) => {
      //   client.end((err) => {
      //     done(err)
      //   })
      // })

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
        })
      })
    })
  })
})
