'use strict'

const { expect } = require('chai')
const semver = require('semver')
const { storage } = require('../../../datadog-core')
const agent = require('../../../dd-trace/test/plugins/agent')

module.exports = (name, factory, versionRange) => {
  describe('Instrumentation', () => {
    let Promise

    describe(name, () => {
      withVersions(name, name, version => {
        if (versionRange && !semver.intersects(version, versionRange)) return

        before(() => {
          return agent.load(name)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          const moduleExports = require(`../../../../versions/${name}@${version}`, {}).get()

          Promise = factory ? factory(moduleExports) : moduleExports
        })

        it('should run the then() callbacks in the context where then() was called', () => {
          const store = 'store'

          let promise = new Promise((resolve, reject) => {
            setImmediate(() => {
              storage.run('promise', () => {
                resolve()
              })
            })
          })

          storage.run(store, () => {
            for (let i = 0; i < promise.then.length; i++) {
              const args = new Array(i + 1)

              args[i] = () => {
                expect(storage.getStore()).to.equal(store)
              }

              promise = promise.then.apply(promise, args)
            }
          })

          return promise
        })

        it('should run the catch() callback in the context where catch() was called', () => {
          const store = storage.getStore()

          let promise = new Promise((resolve, reject) => {
            setImmediate(() => {
              storage.run('promise', () => {
                reject(new Error())
              })
            })
          })

          storage.run(store, () => {
            promise = promise
              .catch(err => {
                throw err
              })
              .catch(() => {
                expect(storage.getStore()).to.equal(store)
              })
          })

          return promise
        })

        it('should allow to run without a scope if not available when calling then()', () => {
          storage.run(null, () => {
            const promise = new Promise((resolve, reject) => {
              setImmediate(() => {
                resolve()
              })
            })

            return promise
              .then(() => {
                expect(storage.getStore()).to.be.null
              })
          })
        })
      })
    })
  })
}
