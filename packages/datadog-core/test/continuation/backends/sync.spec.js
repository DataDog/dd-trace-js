'use strict'

const StorageBackend = require('../../../src/continuation/backends/sync')
const testStorage = require('./test')

describe('continuation/backends/sync', () => {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage, false)
})
