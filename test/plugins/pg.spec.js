'use strict'

const semver = require('semver')
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

      describe('when using a client', () => {
        before(() => {
          return agent.load(plugin, 'pg')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../versions/pg@${version}`).get()

          client = new pg.Client({
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
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

      describe('with configuration', () => {
        before(() => {
          return agent.load(plugin, 'pg', { service: 'custom' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../versions/pg@${version}`).get()

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
    })
  })
})
