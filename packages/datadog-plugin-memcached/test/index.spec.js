'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let Memcached
  let memcached
  let tracer

  describe('memcached', () => {
    withVersions(plugin, 'memcached', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Memcached = require(`../../../versions/memcached@${version}`).get()
      })

      afterEach(() => {
        memcached.end()
      })

      describe('without configuration', () => {
        before(() => agent.load('memcached'))
        after(() => agent.close())

        it('should do automatic instrumentation when using callbacks', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'memcached.command')
              expect(traces[0][0]).to.have.property('service', 'test-memcached')
              expect(traces[0][0]).to.have.property('resource', 'get')
              expect(traces[0][0]).to.have.property('type', 'memcached')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              expect(traces[0][0].meta).to.have.property('out.port', '11211')
              expect(traces[0][0].meta).to.have.property('memcached.command', 'get test')
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should run the callback in the parent context', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          const span = tracer.startSpan('web.request')

          tracer.scope().activate(span, () => {
            memcached.get('test', err => {
              expect(tracer.scope().active()).to.equal(span)
              done(err)
            })
          })
        })

        it('should handle errors', done => {
          memcached = new Memcached('localhost:11211', { retries: 0 })

          let error

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          memcached.touch('test', 'invalid', err => {
            error = err
          })
        })

        it('should support an array of servers', done => {
          memcached = new Memcached(['localhost:11211'], { retries: 0 })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              expect(traces[0][0].meta).to.have.property('out.port', '11211')
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should support an object of servers with weights', done => {
          memcached = new Memcached({
            'localhost:11211': 1,
            'other:11211': 1
          }, { retries: 0 })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              expect(traces[0][0].meta).to.have.property('out.port', '11211')
            })
            .then(done)
            .catch(done)

          memcached.get('test', err => err && done(err))
        })

        it('should support redundancy', done => {
          memcached = new Memcached({
            'localhost:11211': 1,
            'other:11211': 1
          }, {
            retries: 0,
            redundancy: 1
          })

          try {
            memcached.del('test', err => err && done(err))

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
                expect(traces[0][0].meta).to.have.property('out.port', '11211')
              })
              .then(done)
              .catch(done)
          } catch (e) {
            // Bug in memcached will throw. Skip test when this happens.
            done()
          }
        })
      })

      describe('with configuration', () => {
        before(() => agent.load('memcached', { service: 'custom' }))
        after(() => agent.close())

        beforeEach(() => {
          memcached = new Memcached('localhost:11211', { retries: 0 })
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          memcached.version(err => err && done(err))
        })
      })
    })
  })
})
