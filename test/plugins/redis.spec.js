'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/redis')

wrapIt()

describe('Plugin', () => {
  let redis
  let tracer
  let client

  describe('redis', () => {
    withVersions(plugin, 'redis', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        client.quit()
        agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'redis')
            .then(() => {
              redis = require(`./versions/redis@${version}`).get()
              client = redis.createClient()
            })
        })

        it('should do automatic instrumentation when using callbacks', done => {
          client.on('error', done)

          agent.use(() => client.get('foo')) // wait for initial info command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'redis.command')
              expect(traces[0][0]).to.have.property('service', 'test-redis')
              expect(traces[0][0]).to.have.property('resource', 'get')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
              expect(traces[0][0].meta).to.have.property('out.port', '6379')
            })
            .then(done)
            .catch(done)
        })

        it('should run the callback in the parent context', done => {
          client.on('error', done)

          client.get('foo', () => {
            expect(tracer.scopeManager().active()).to.be.null
            done()
          })
        })

        it('should run client emitter listeners in the parent context', done => {
          client.on('error', done)

          client.on('ready', () => {
            expect(tracer.scopeManager().active()).to.be.null
            done()
          })
        })

        it('should run stream emitter listeners in the parent context', done => {
          client.on('error', done)

          client.stream.on('close', () => {
            expect(tracer.scopeManager().active()).to.be.null
            done()
          })

          client.stream.destroy()
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
              redis = require(`./versions/redis@${version}`).get()
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
})
