'use strict'

const t = require('tap')
require('../../dd-trace/test/setup/core')

const { expect } = require('chai')
const { executionAsyncResource } = require('async_hooks')
const { storage } = require('../src/storage')

t.test('storage', t => {
  let testStorage
  let testStorage2

  t.beforeEach(() => {
    testStorage = storage('test')
    testStorage2 = storage('test2')
  })

  t.afterEach(() => {
    testStorage.enterWith(undefined)
    testStorage2.enterWith(undefined)
  })

  t.test('should enter a store', t => {
    const store = 'foo'

    testStorage.enterWith(store)

    setImmediate(() => {
      expect(testStorage.getStore()).to.equal(store)
      t.end()
    })
  })

  t.test('should enter stores by namespace', t => {
    const store = 'foo'
    const store2 = 'bar'

    testStorage.enterWith(store)
    testStorage2.enterWith(store2)

    setImmediate(() => {
      expect(testStorage.getStore()).to.equal(store)
      expect(testStorage2.getStore()).to.equal(store2)
      t.end()
    })
  })

  t.test('should return the same storage for a namespace', t => {
    expect(storage('test')).to.equal(testStorage)
    t.end()
  })

  t.test('should not have its store referenced by the underlying async resource', t => {
    const resource = executionAsyncResource()

    testStorage.enterWith({ internal: 'internal' })

    for (const sym of Object.getOwnPropertySymbols(resource)) {
      if (sym.toString() === 'Symbol(kResourceStore)' && resource[sym]) {
        expect(resource[sym]).to.not.have.property('internal')
      }
    }
    t.end()
  })
  t.end()
})
