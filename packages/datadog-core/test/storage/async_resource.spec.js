'use strict'

require('../setup')

const StorageBackend = require('../../src/storage/async_resource')
const testStorage = require('./test')

describe('storage/async_resource', () => {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage)
})
