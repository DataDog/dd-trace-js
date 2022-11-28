'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

describe('Plugin', () => {
  let redis
  let tracer
  let client
  let pub
  let sub

  describe('redis', () => {
    withVersions('redis', 'redis', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        client.quit(() => {})
        pub.quit(() => {})
        sub.quit(() => {})
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
          pub = redis.createClient()
          sub = redis.createClient()
        })

        it('should do automatic instrumentation when using callbacks', done => {
          client.on('error', done)
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
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
              expect(traces[0][0].metrics).to.have.property('out.port', 6379)
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })

        it('should support commands without a callback', done => {
          sub.on('error', done)
          sub.on('message', () => done())
          sub.subscribe('foo')

          sub.on('subscribe', () => {
            pub.on('error', done)
            pub.publish('foo', 'test')
          })
        })

        it('should run the callback in the parent context', done => {
          client.on('error', done)

          client.get('foo', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should run client emitter listeners in the parent context', done => {
          client.on('error', done)

          client.on('ready', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })
        })

        it('should run stream emitter listeners in the parent context', done => {
          client.on('error', done)

          client.stream.on('close', () => {
            expect(tracer.scope().active()).to.be.null
            done()
          })

          client.stream.destroy()
        })

        it('should handle errors', done => {
          const assertError = () => {
            if (!error || !span) return

            try {
              expect(span.meta).to.have.property(ERROR_TYPE, error.name)
              expect(span.meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(span.meta).to.have.property(ERROR_STACK, error.stack)
              expect(span.meta).to.have.property('component', 'redis')

              done()
            } catch (e) {
              done(e)
            }
          }

          let error
          let span

          agent.use(traces => {
            expect(traces[0][0]).to.have.property('resource', 'set')
            span = traces[0][0]
            assertError()
          })

          client.on('error', done)

          client.set('foo', 123, 'bar', (err, res) => {
            error = err
            assertError()
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            allowlist: ['get']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
          client.on('error', done)
        })

        it('should be able to filter commands', done => {
          agent.use(() => {}) // wait for initial command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })
      })

      describe('with legacy configuration', () => {
        before(() => {
          return agent.load('redis', {
            whitelist: ['get']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          redis = require(`../../../versions/redis@${version}`).get()
          client = redis.createClient()
        })

        it('should be able to filter commands', done => {
          agent.use(() => {}) // wait for initial command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })
      })
    })
  })
})
