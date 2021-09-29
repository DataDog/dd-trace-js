'use strict'

const { expect } = require('chai')
const { AsyncResource, executionAsyncId } = require('async_hooks')

module.exports = (factory, supportsAsync = true) => {
  let storage
  let store

  beforeEach(() => {
    storage = factory()
    store = {}
  })

  describe('getStore()', () => {
    it('should return undefined by default', () => {
      expect(storage.getStore()).to.be.undefined
    })
  })

  describe('run()', () => {
    it('should return the value returned by the callback', () => {
      expect(storage.run(store, () => 'test')).to.equal('test')
    })

    it('should preserve the surrounding scope', () => {
      expect(storage.getStore()).to.be.undefined

      storage.run(store, () => {})

      expect(storage.getStore()).to.be.undefined
    })

    it('should run the span on the current scope', () => {
      expect(storage.getStore()).to.be.undefined

      storage.run(store, () => {
        expect(storage.getStore()).to.equal(store)
      })

      expect(storage.getStore()).to.be.undefined
    })

    if (supportsAsync) {
      it('should persist through setTimeout', done => {
        storage.run(store, () => {
          setTimeout(() => {
            expect(storage.getStore()).to.equal(store)
            done()
          }, 0)
        })
      })

      it('should persist through setImmediate', done => {
        storage.run(store, () => {
          setImmediate(() => {
            expect(storage.getStore()).to.equal(store)
            done()
          }, 0)
        })
      })

      it('should persist through setInterval', done => {
        storage.run(store, () => {
          let shouldReturn = false

          const timer = setInterval(() => {
            expect(storage.getStore()).to.equal(store)

            if (shouldReturn) {
              clearInterval(timer)
              return done()
            }

            shouldReturn = true
          }, 0)
        })
      })

      if (global.process && global.process.nextTick) {
        it('should persist through process.nextTick', done => {
          storage.run(store, () => {
            process.nextTick(() => {
              expect(storage.getStore()).to.equal(store)
              done()
            }, 0)
          })
        })
      }

      it('should persist through promises', () => {
        const promise = Promise.resolve()

        return storage.run(store, () => {
          return promise.then(() => {
            expect(storage.getStore()).to.equal(store)
          })
        })
      })

      it('should handle concurrency', done => {
        storage.run(store, () => {
          setImmediate(() => {
            expect(storage.getStore()).to.equal(store)
            done()
          })
        })

        storage.run(store, () => {})
      })

      it('should not break propagation for nested resources', done => {
        storage.run(store, () => {
          const asyncResource = new AsyncResource(
            'TEST', { triggerAsyncId: executionAsyncId(), requireManualDestroy: false }
          )

          asyncResource.runInAsyncScope(() => {})

          expect(storage.getStore()).to.equal(store)

          done()
        })
      })
    }
  })

  describe('enterWith()', () => {
    it('should transition into the context for the remainder of the current execution', () => {
      const newStore = {}

      storage.run(store, () => {
        storage.enterWith(newStore)
        expect(storage.getStore()).to.equal(newStore)
      })

      expect(storage.getStore()).to.be.undefined
    })
  })
}
