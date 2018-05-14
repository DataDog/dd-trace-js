'use strict'

const agent = require('./agent')

describe('Plugin', () => {
  let plugin
  let redis
  let context
  let client

  describe('redis', () => {
    beforeEach(() => {
      redis = require('redis')
      plugin = require('../../src/plugins/redis')
      context = require('../../src/platform').context({ experimental: { asyncHooks: false } })
    })

    afterEach(() => {
      client.quit()
      agent.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'redis')
          .then(() => {
            client = redis.createClient()
          })
      })

      it('should do automatic instrumentation when using callbacks', done => {
        client.on('error', done)

        agent.use(() => client.get('foo')) // wait for initial info command
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'redis.command')
            expect(traces[0][0]).to.have.property('service', 'redis')
            expect(traces[0][0]).to.have.property('resource', 'get')
            expect(traces[0][0]).to.have.property('type', 'db')
            expect(traces[0][0].meta).to.have.property('db.name', '0')
            expect(traces[0][0].meta).to.have.property('db.type', 'redis')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
            expect(traces[0][0].meta).to.have.property('out.port', '6379')
          })
          .then(done)
          .catch(done)
      })

      it('should propagate context to callbacks', done => {
        client.on('error', done)

        context.run(() => {
          context.set('foo', 'bar')
          client.get('foo', callback)
        })

        function callback () {
          expect(context.get('foo')).to.equal('bar')
          done()
        }
      })

      it('should propagate context to client emitters', done => {
        client.on('error', done)

        context.run(() => {
          context.set('foo', 'bar')
          client.on('ready', callback)
        })

        function callback () {
          expect(context.get('foo')).to.equal('bar')
          done()
        }
      })

      it('should propagate context to stream emitters', done => {
        client.on('error', done)

        context.run(() => {
          context.set('foo', 'bar')
          client.stream.on('close', callback)
        })

        client.stream.destroy()

        function callback () {
          expect(context.get('foo')).to.equal('bar')
          done()
        }
      })

      it('should handle errors', done => {
        let error

        client.on('error', done)

        agent.use(() => { // wait for initial info command
          client.set('foo', 123, 'bar', (err, res) => {
            error = err
          })
        })

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
          })
          .then(done)
          .catch(done)
      })
    })

    describe('with configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom'
        }

        return agent.load(plugin, 'redis', config)
          .then(() => {
            client = redis.createClient()
          })
      })

      it('should be configured with the correct values', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')
          })
          .then(done)
          .catch(done)

        client.on('error', done)
      })
    })
  })
})
