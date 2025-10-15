'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')

require('..')

const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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

        storage('legacy').run(store, () => {
          pool.acquire((err, resource) => {
            pool.release(resource)
            expect(storage('legacy').getStore()).to.equal(store)
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

        storage('legacy').run(store, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage('legacy').getStore()).to.equal(store)
            })
            .catch(done)
        })

        storage('legacy').run(store2, () => {
          pool.acquire()
            .then(resource => {
              pool.release(resource)
              expect(storage('legacy').getStore()).to.equal(store2)
              done()
            })
            .catch(done)
        })
      })
    })
  })
})
