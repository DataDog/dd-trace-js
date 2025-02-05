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
    testStorage(SPAN_NAMESPACE).enterWith(undefined)
    testStorage2.enterWith(undefined)
  })

  it('should enter a store', done => {
    const store = 'foo'

    testStorage(SPAN_NAMESPACE).enterWith(store)

    setImmediate(() => {
      expect(testStorage(SPAN_NAMESPACE).getStore()).to.equal(store)
      done()
    })
  })

  it('should enter stores by namespace', done => {
    const store = 'foo'
    const store2 = 'bar'

    testStorage(SPAN_NAMESPACE).enterWith(store)
    testStorage2.enterWith(store2)

    setImmediate(() => {
      expect(testStorage(SPAN_NAMESPACE).getStore()).to.equal(store)
      expect(testStorage2.getStore()).to.equal(store2)
      done()
    })
  })

  it('should return the same storage for a namespace', () => {
    expect(storage('test')).to.equal(testStorage)
  })

  it('should not have its store referenced by the underlying async resource', () => {
    const resource = executionAsyncResource()

    testStorage(SPAN_NAMESPACE).enterWith({ internal: 'internal' })

    for (const sym of Object.getOwnPropertySymbols(resource)) {
      if (sym.toString() === 'Symbol(kResourceStore)' && resource[sym]) {
        expect(resource[sym]).to.not.have.property('internal')
      }
    }
  })
})
