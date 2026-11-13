'use strict'

const { storage } = require('../../datadog-core')

const legacyStorage = storage('legacy')

class DataloaderTestSetup {
  setup (DataLoader) {
    this.loader = new DataLoader(keys => {
      this.batchStore = legacyStorage.getStore()
      return Promise.resolve(keys.map(key => ({ key, value: `value-${key}` })))
    }, {
      name: 'users',
    })
    this.rejectingLoader = new DataLoader(async () => {
      throw new Error('batch failed')
    }, { name: 'rejecting' })
  }

  teardown () {
    this.loader = undefined
    this.rejectingLoader = undefined
    this.batchStore = undefined
  }

  // --- Operations ---
  async dataLoaderLoad () {
    return this.loader.load('a')
  }

  async dataLoaderLoadError () {
    return this.rejectingLoader.load('a')
  }

  async dataLoaderLoadMany () {
    return this.loader.loadMany(['b', 'c'])
  }

  async dataLoaderLoadManyError () {
    return this.rejectingLoader.loadMany(['a'])
  }

  async dataLoaderLoadManyValidationError () {
    return this.loader.loadMany(null)
  }
}

module.exports = DataloaderTestSetup
