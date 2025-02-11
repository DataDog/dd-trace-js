'use strict'

require('../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const { executionAsyncResource } = require('async_hooks')
const storage = require('../src/storage')

describe('storage', () => {
  let testStorage
  let testStorage2

  beforeEach(() => {
    testStorage = storage('test')
    testStorage2 = storage('test2')
  })

  afterEach(() => {
    testStorage('legacy').enterWith(undefined)
    testStorage2.enterWith(undefined)
  })

  it('should enter a store', done => {
    const store = 'foo'

    testStorage('legacy').enterWith(store)

    setImmediate(() => {
      expect(testStorage('legacy').getStore()).to.equal(store)
      done()
    })
  })

  it('should enter stores by namespace', done => {
    const store = 'foo'
    const store2 = 'bar'

    testStorage('legacy').enterWith(store)
    testStorage2.enterWith(store2)

    setImmediate(() => {
      expect(testStorage('legacy').getStore()).to.equal(store)
      expect(testStorage2.getStore()).to.equal(store2)
      done()
    })
  })

  it('should return the same storage for a namespace', () => {
    expect(storage('test')).to.equal(testStorage)
  })

  it('should not have its store referenced by the underlying async resource', () => {
    const resource = executionAsyncResource()

    testStorage('legacy').enterWith({ internal: 'internal' })

    for (const sym of Object.getOwnPropertySymbols(resource)) {
      if (sym.toString() === 'Symbol(kResourceStore)' && resource[sym]) {
        expect(resource[sym]).to.not.have.property('internal')
      }
    }
  })
})
