'use strict'

const StorageBackend = require('../../../src/continuation/backends/async_resource')
const testStorage = require('./test')
const semver = require('semver')

// https:// nodejs.org/api/async_hooks.html#async_hooks_async_hooks_executionasyncresource
if (semver.satisfies(process.version, '^12.17.0 || >=13.9.0')) {
  describe('continuation/backends/async_resource', test)
} else {
  describe.skip('continuation/backends/async_resource', test)
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
