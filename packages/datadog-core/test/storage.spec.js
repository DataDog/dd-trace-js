'use strict'

require('../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const storage = require('../src/storage')

describe('storage', () => {
  let testStorage
  let testStorage2

  beforeEach(() => {
    testStorage = storage('test')
    testStorage2 = storage('test2')
  })

  afterEach(() => {
    testStorage.enterWith(undefined)
    testStorage2.enterWith(undefined)
  })

  it('should enter a store', done => {
    const store = 'foo'

    testStorage.enterWith(store)

    setImmediate(() => {
      expect(testStorage.getStore()).to.equal(store)
      done()
    })
  })

  it('should enter stores by namespace', done => {
    const store = 'foo'
    const store2 = 'bar'

    testStorage.enterWith(store)
    testStorage2.enterWith(store2)

    setImmediate(() => {
      expect(testStorage.getStore()).to.equal(store)
      expect(testStorage2.getStore()).to.equal(store2)
      done()
    })
  })

  it('should return the same storage for a namespace', () => {
    expect(storage('test')).to.equal(testStorage)
  })
})
