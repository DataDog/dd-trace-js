'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/generic-pool')

wrapIt()

describe('Plugin', () => {
  let genericPool
  let pool
  let tracer

  describe('generic-pool', () => {
    beforeEach(() => {
      tracer = require('../..')
    })

    afterEach(() => {
      return agent.close()
    })

    withVersions(plugin, 'generic-pool', '2', version => {
      beforeEach(() => {
        return agent.load(plugin, 'generic-pool')
          .then(() => {
            genericPool = require(`../../versions/generic-pool@${version}`).get()
          })
      })

      beforeEach(() => {
        pool = new genericPool.Pool({
          create (cb) {
            setImmediate(() => {
              cb(null, {})
            })
          },
          destroy () {}
        })
      })

      it('should run the acquire() callback in context where acquire() was called', done => {
        const span = tracer.startSpan('test')
        const span2 = tracer.startSpan('test')

        tracer.scope().activate(span, () => {
          pool.acquire((err, resource) => {
            pool.release(resource)
            expect(tracer.scope().active()).to.equal(span)
          })
        })

        tracer.scope().activate(span2, () => {
          pool.acquire((err, resource) => {
            pool.release(resource)
            expect(tracer.scope().active()).to.equal(span2)
            done()
          })
        })
      })
    })

    withVersions(plugin, 'generic-pool', '>=3', version => {
      beforeEach(() => {
        return agent.load(plugin, 'generic-pool')
          .then(() => {
            genericPool = require(`../../versions/generic-pool@${version}`).get()
          })
      })

      beforeEach(() => {
        pool = genericPool.createPool({
          create () {
            return Promise.resolve({})
          },
          destroy () {}
        })
      })

      it('should run the acquire() callback in context where acquire() was called', done => {
        const span = tracer.startSpan('test')
        const span2 = tracer.startSpan('test')

        tracer.scope().activate(span, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(tracer.scope().active()).to.equal(span)
            })
            .catch(done)
        })

        tracer.scope().activate(span2, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(tracer.scope().active()).to.equal(span2)
              done()
            })
            .catch(done)
        })
      })
    })
  })
})
