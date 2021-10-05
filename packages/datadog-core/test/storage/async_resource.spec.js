'use strict'

const StorageBackend = require('../../src/storage/async_resource')
const testStorage = require('./test')
const semver = require('semver')

// https://nodejs.org/api/async_hooks.html#async_hooks_async_hooks_executionasyncresource
if (semver.satisfies(process.version, '^12.17.0 || >=13.9.0')) {
  describe('storage/async_resource', test)
} else {
  describe.skip('storage/async_resource', test)
}

function test () {
  let storage

  beforeEach(() => {
    storage = new StorageBackend()
  })

  afterEach(() => {
    storage.disable()
  })

  testStorage(() => storage)
}
