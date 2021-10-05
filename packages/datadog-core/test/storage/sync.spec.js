'use strict'

const StorageBackend = require('../../src/storage/sync')
const testStorage = require('./test')

describe('storage/sync', () => {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage, false)
})
