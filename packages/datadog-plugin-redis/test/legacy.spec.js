'use strict'

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Legacy Plugin', () => {
  let redis
  let tracer
  let client
  let pub
  let sub

  describe('redis', () => {
    withVersions('redis', 'redis', '<4', version => {
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

        withPeerService(
          () => tracer,
          'redis',
          (done) => client.get('foo', done),
          '127.0.0.1',
          'out.host'
        )

        it('should do automatic instrumentation when using callbacks', done => {
          client.on('error', done)
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'get')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
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

        // TODO: This test is flakey. I've seen it affect 2.6.0, 2.5.3, 3.1.2, 0.12.0
        // Increasing the test timeout does not help.
        // Error will be set but span will not.
        // agent.assertSomeTraces is called a dozen times per test in legacy.spec but once per test in client.spec
        it.skip('should handle errors', done => {
          const assertError = () => {
            if (!error || !span) return

            try {
              expect(span.meta).to.have.property(ERROR_TYPE, error.name)
              expect(span.meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(span.meta).to.have.property(ERROR_STACK, error.stack)
              expect(span.meta).to.have.property('component', 'redis')
              expect(span.metrics).to.have.property('network.destination.port', 6379)
              done()
            } catch (e) {
              done(e)
            }
          }

          let error
          let span

          agent.assertSomeTraces(traces => {
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

        withNamingSchema(
          () => client.get('foo', () => {}),
          rawExpectedSchema.outbound
        )
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
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
          client.on('error', done)
        })

        it('should be able to filter commands', done => {
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          client.get('foo', () => {})
        })

        withNamingSchema(
          () => client.get('foo', () => {}),
          {
            v0: {
              opName: 'redis.command',
              serviceName: 'custom'
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom'
            }
          }
        )
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
          agent.assertSomeTraces(() => {}) // wait for initial command
          agent
            .assertSomeTraces(traces => {
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
