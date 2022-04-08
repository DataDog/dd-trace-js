'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')

describe('Plugin', () => {
  let Redis
  let redis
  let tracer

  describe('ioredis', () => {
    withVersions('ioredis', 'ioredis', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Redis = require(`../../../versions/ioredis@${version}`).get()
        redis = new Redis({ connectionName: 'test' })
      })

      afterEach(() => {
        unbreakThen(Promise.prototype)
        redis.quit()
      })

      describe('without configuration', () => {
        before(() => agent.load(['ioredis']))
        after(() => agent.close({ ritmReset: false }))

        it('should do automatic instrumentation when using callbacks', done => {
          agent.use(() => {}) // wait for initial info command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'redis.command')
              expect(traces[0][0]).to.have.property('service', 'test-redis')
              expect(traces[0][0]).to.have.property('resource', 'get')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].metrics).to.have.property('out.port', 6379)
            })
            .then(done)
            .catch(done)

          redis.get('foo').catch(done)
        })

        it('should run the callback in the parent context', () => {
          const span = {}

          return tracer.scope().activate(span, () => {
            return redis.get('foo')
              .then(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })

        it('should handle errors', done => {
          let error

          agent.use(() => {}) // wait for initial info command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          redis.set('foo', 123, 'bar')
            .catch(err => {
              error = err
            })
        })

        it('should work with userland promises', done => {
          agent.use(() => {}) // wait for initial info command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'redis.command')
              expect(traces[0][0]).to.have.property('service', 'test-redis')
              expect(traces[0][0]).to.have.property('resource', 'get')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].metrics).to.have.property('out.port', 6379)
            })
            .then(done)
            .catch(done)

          breakThen(Promise.prototype)

          redis.get('foo').catch(done)
        })
      })

      describe('with configuration', () => {
        before(() => agent.load('ioredis', {
          service: 'custom',
          splitByInstance: true,
          allowlist: ['get']
        }))
        after(() => agent.close({ ritmReset: false }))

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom-test')
            })
            .then(done)
            .catch(done)

          redis.get('foo').catch(done)
        })

        it('should be able to filter commands', done => {
          agent.use(() => {}) // wait for initial command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          redis.get('foo').catch(done)
        })
      })

      describe('with legacy configuration', () => {
        before(() => agent.load('ioredis', {
          whitelist: ['get']
        }))
        after(() => agent.close({ ritmReset: false }))

        it('should be able to filter commands', done => {
          agent.use(() => {}) // wait for initial command
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'get')
            })
            .then(done)
            .catch(done)

          redis.get('foo').catch(done)
        })
      })
    })
  })
})
