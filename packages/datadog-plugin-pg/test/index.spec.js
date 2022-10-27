'use strict'

const { log } = require('console')
const semver = require('semver')
const Client = require('../../dd-trace/src/dogstatsd')
const agent = require('../../dd-trace/test/plugins/agent')

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

          it('should handle errors', done => {
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

    describe('with sql comment injection enabled with service', () => {
      
      before(() => {
        return agent.load('pg', [{sqlInjectionMode: 'service', service:'serviced'}])
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

      it('should contain comment in query text', done => {
        const client = new pg.Client({
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

          if(client.queryQueue[0] !== undefined) {
            try {
              expect(client.queryQueue[0].text).to.equal(`/*dddbs='serviced',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT $1::text as message`)
            }
            catch (e) {
              done(e)
            }
          }

      })

      it('trace query resource should not be changed when comment injection is enabled', done => {

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

    describe('sql injection should handle special characters', () => {
      let clientDBM
      before(() => {
        return agent.load('pg', [{sqlInjectionMode: 'service', service:'~!@#$%^&*()_+|??/<>'}])
      })

      after(() => {
        return agent.close({ ritmReset: false })

      })
      beforeEach(done => {
        pg = require(`../../../versions/pg@${version}`).get()

        clientDBM = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres'
        })

        clientDBM.connect(err => done(err))
      })

      it('comment injection should handle special characters', done => {

        clientDBM.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
          if (err) return done(err)

          clientDBM.end((err) => {
            if (err) return done(err)
          })
        })

        if(clientDBM.queryQueue[0] !== undefined) {
          try {
              expect(clientDBM.queryQueue[0].text).to.equal(`/*dddbs='~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E',dde='tester',ddps='test',ddpv='8.4.0'*/ SELECT $1::text as message`)
              done()
            }
            catch (e) {
              done(e)
            }
          }

      })
    }) 
  })
})
})
