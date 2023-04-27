'use strict'

const Runner = require('../../../../src/appsec/gateway/engine/runner')
const als = require('../../../../src/appsec/gateway/als')

describe('Gateway Runner', () => {
  describe('runSubscriptions', () => {
    it('should return empty array when passed empty set', () => {
      const result = Runner.runSubscriptions(new Set(), {})

      expect(result).to.be.an('array').that.is.empty
    })

    it('should return empty array when called recursively', () => {
      const subscriptions = [
        { callback: { method: () => 'a' } },
        { callback: { method: () => Runner.runSubscriptions(new Set(subscriptions)) } },
        { callback: { method: () => 'c' } }
      ]

      const result = Runner.runSubscriptions(new Set(subscriptions), {})

      expect(result).to.deep.equal(['a', [], 'c'])
    })

    it('should execute callbacks', () => {
      const params = {}

      const store = {}

      const subscriptions = [
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'a'
            }
          }
        },
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'b'
            }
          }
        },
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'c'
            }
          }
        }
      ]

      als.run(store, () => {
        const result = Runner.runSubscriptions(new Set(subscriptions), params)

        expect(result).to.deep.equal(['a', 'b', 'c'])
      })
    })

    it('should execute a callback only once if present multiple times', () => {
      const params = {}

      const store = {}

      const method = sinon.spy((p, s) => {
        expect(p).to.equal(params)
        expect(s).to.equal(store)

        return 'a'
      })

      const callback = { method }

      const subscriptions = [
        {
          callback
        },
        {
          callback: {
            method
          }
        },
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'b'
            }
          }
        },
        {
          callback
        }
      ]

      als.run(store, () => {
        const result = Runner.runSubscriptions(new Set(subscriptions), params)

        expect(method).to.have.been.calledTwice
        expect(result).to.deep.equal(['a', 'a', 'b'])
      })
    })

    it('should continue if a callback throws', () => {
      const params = {}

      const store = {}

      const subscriptions = [
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'a'
            }
          }
        },
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              throw new Error('test')
            }
          }
        },
        {
          callback: {
            method: (p, s) => {
              expect(p).to.equal(params)
              expect(s).to.equal(store)

              return 'c'
            }
          }
        }
      ]

      als.run(store, () => {
        const result = Runner.runSubscriptions(new Set(subscriptions), params)

        expect(result).to.deep.equal(['a', undefined, 'c'])
      })
    })
  })
})
