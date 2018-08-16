'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/pg')

wrapIt()

describe('Plugin', () => {
  let pg
  let client
  let tracer

  describe('pg', () => {
    withVersions(plugin, 'pg', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        agent.close()
      })

      describe('when using a client', () => {
        beforeEach(done => {
          agent.load(plugin, 'pg')
            .then(() => {
              pg = require(`./versions/pg@${version}`).get()

              client = new pg.Client({
                user: 'postgres',
                password: 'postgres',
                database: 'postgres',
                application_name: 'test'
              })

              client.connect(err => done(err))
            })
            .catch(done)
        })

        it('should do automatic instrumentation when using callbacks', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'test-postgres')
            expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
            expect(traces[0][0]).to.have.property('type', 'sql')
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

        it('should handle errors', done => {
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', 'error')
            expect(traces[0][0].meta).to.have.property('error.msg', 'syntax error at or near "INVALID"')
            expect(traces[0][0].meta).to.have.property('error.stack')

            done()
          })

          client.query('INVALID', (err, result) => {
            expect(err).to.be.an('error')

            client.end((err) => {
              if (err) throw err
            })
          })
        })

        it('should run the callback in the parent context', done => {
          const span = {}
          const scope = tracer.scopeManager().activate(span)

          client.query('SELECT $1::text as message', ['Hello World!'], () => {
            const active = tracer.scopeManager().active()
            expect(active.span()).to.equal(scope.span())
            done()
          })

          client.end((err) => {
            if (err) throw err
          })
        })

        it('should work without a callback', done => {
          agent.use(traces => {
            done()
          })

          client.query('SELECT $1::text as message', ['Hello World!'])
          client.end((err) => {
            if (err) throw err
          })
        })
      })

      describe('when using a pool', () => {
        let pool

        beforeEach(done => {
          agent.load(plugin, 'pg')
            .then(() => {
              pg = require('pg')

              pool = new pg.Pool({
                user: 'postgres',
                password: 'postgres',
                database: 'postgres',
                application_name: 'test'
              })

              pool.connect((err, c) => {
                client = c
                done(err)
              })
            })
            .catch(done)
        })

        afterEach(() => {
          client && client.release()
        })

        it('should run the callback in the parent context', done => {
          const span = {}
          const scope = tracer.scopeManager().activate(span)

          pool.query('SELECT $1::text as message', ['Hello World!'], () => {
            const active = tracer.scopeManager().active()
            expect(active.span()).to.equal(scope.span())
            done()
          })

          pool.end((err) => {
            if (err) throw err
          })
        })
      })

      describe('with configuration', () => {
        let config

        beforeEach(done => {
          config = {
            service: 'custom'
          }

          agent.load(plugin, 'pg', config)
            .then(() => {
              pg = require('pg')

              client = new pg.Client({
                user: 'postgres',
                password: 'postgres',
                database: 'postgres'
              })

              client.connect(err => done(err))
            })
            .catch(done)
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
    })
  })
})
