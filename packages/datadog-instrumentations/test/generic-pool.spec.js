'use strict'

require('..')
const { storage, LEGACY_STORAGE_NAMESPACE } = require('../../datadog-core')

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

        storage(LEGACY_STORAGE_NAMESPACE).run(store, () => {
          // eslint-disable-next-line n/handle-callback-err
          pool.acquire((err, resource) => {
            pool.release(resource)
            expect(storage(LEGACY_STORAGE_NAMESPACE).getStore()).to.equal(store)
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

        storage(LEGACY_STORAGE_NAMESPACE).run(store, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage(LEGACY_STORAGE_NAMESPACE).getStore()).to.equal(store)
            })
            .catch(done)
        })

        storage(LEGACY_STORAGE_NAMESPACE).run(store2, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage(LEGACY_STORAGE_NAMESPACE).getStore()).to.equal(store2)
              done()
            })
            .catch(done)
        })
      })
    })
  })
})
