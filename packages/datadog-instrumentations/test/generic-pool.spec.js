'use strict'

require('../../dd-trace/test/setup/core')

require('..')
const { storage } = require('../../datadog-core')

describe('Instrumentation', () => {
  let genericPool
  let pool

  describe('generic-pool', () => {
    withVersions('generic-pool', 'generic-pool', '2', version => {
      beforeEach(() => {
        genericPool = require(`../../../versions/generic-pool@${version}`).get()
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
        const store = 'store'

        storage.run(store, () => {
          pool.acquire((err, resource) => {
            pool.release(resource)
            expect(storage.getStore()).to.equal(store)
            done()
          })
        })
      })
    })

    withVersions('generic-pool', 'generic-pool', '>=3', version => {
      beforeEach(() => {
        genericPool = require(`../../../versions/generic-pool@${version}`).get()
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
        const store = 'store'
        const store2 = 'store2'

        storage.run(store, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage.getStore()).to.equal(store)
            })
            .catch(done)
        })

        storage.run(store2, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage.getStore()).to.equal(store2)
              done()
            })
            .catch(done)
        })
      })
    })
  })
})
