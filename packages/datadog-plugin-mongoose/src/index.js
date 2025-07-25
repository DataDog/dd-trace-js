'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { storage } = require('../../datadog-core')

class MongoosePlugin extends DatabasePlugin {
  static get id () { return 'mongoose' }

  constructor (tracer, config) {
    super(tracer, config)

    // Ensure the current store is preserved across the
    // internal callback channel used by the instrumentation.
    // We ignore the `ctx` argument and just return the active store so that
    // `runStores()` will automatically re-enter it.
    this.addBind('datadog:mongoose:model:exec:callback', () => {
      return storage('legacy').getStore()
    })
  }
}

module.exports = MongoosePlugin
