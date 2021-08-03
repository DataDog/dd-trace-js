'use strict'

const StorageBackend = require('../../../src/continuation/backends/async_hooks')
const testStorage = require('./test')

describe('continuation/backends/async_hooks', () => {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage)
})
