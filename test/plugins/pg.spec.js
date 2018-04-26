'use strict'

const agent = require('./agent')

describe('Plugin', () => {
  let plugin
  let pg

  describe('pg', () => {
    beforeEach(() => {
      pg = require('pg')
      plugin = proxyquire('../src/plugins/pg', { 'pg': pg })
    })

    afterEach(() => {
      agent.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'pg')
      })

      it('should do automatic instrumentation when using callbacks', done => {
        agent.use(traces => {
          expect(traces[0][0]).to.have.property('service', 'postgres')
          expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
          expect(traces[0][0]).to.have.property('type', 'db')
          expect(traces[0][0].meta).to.have.property('db.name', 'postgres')
          expect(traces[0][0].meta).to.have.property('db.user', 'postgres')
          expect(traces[0][0].meta).to.have.property('db.type', 'postgres')
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')

          done()
        })

        const client = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test'
        })

        client.connect((err) => {
          if (err) throw err

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
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

        const client = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres'
        })

        client.connect((err) => {
          if (err) throw err

          client.query('INVALID', (err, result) => {
            expect(err).to.be.an('error')

            client.end((err) => {
              if (err) throw err
            })
          })
        })
      })

      it('should work without a callback', done => {
        agent.use(traces => {
          done()
        })

        const client = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres'
        })

        client.connect((err) => {
          if (err) throw err

          client.query('SELECT $1::text as message', ['Hello World!'])
          client.end((err) => {
            if (err) throw err
          })
        })
      })
    })

    describe('with configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom'
        }

        return agent.load(plugin, 'pg', config)
      })

      it('should be configured with the correct values', done => {
        agent.use(traces => {
          expect(traces[0][0]).to.have.property('service', 'custom')

          done()
        })

        const client = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres'
        })

        client.connect((err) => {
          if (err) throw err

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
