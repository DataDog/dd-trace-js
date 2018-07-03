'use strict'

const agent = require('./agent')

wrapIt()

describe('Plugin', () => {
  let plugin
  let pg
  let client
  let context

  describe('pg', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/pg')
      context = require('../../src/platform').context({ experimental: { asyncHooks: false } })
    })

    afterEach(() => {
      agent.close()
    })

    describe('without configuration', () => {
      beforeEach(done => {
        agent.load(plugin, 'pg')
          .then(() => {
            pg = require('pg')

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
          expect(traces[0][0]).to.have.property('service', 'postgres')
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
        client.query('SELECT $1::text as message', ['Hello World!'], () => {
          expect(context.get('current')).to.be.undefined
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
