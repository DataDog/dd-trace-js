'use strict'

const StorageBackend = require('../../src/storage/async_hooks')
const testStorage = require('./test')

describe('storage/async_hooks', () => {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage)
})
