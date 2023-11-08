'use strict'

const { storage } = require('../../datadog-core')
// const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class AerospikePlugin extends DatabasePlugin {
  static get id () { return 'aerospike' }
  static get operation () { return 'command' }
  static get system () { return 'aerospike' }

  bindStart (obj) {
    const store = storage.getStore()
    const childOf = store ? store.span : null
    const span = this.startSpan('chicken', {
      childOf,
      meta: {
      }
    }, false)
    obj.parentStore = store
    obj.currentStore = { ...store, span }

    return obj.currentStore
  }

  bindAsyncStart (obj) {
    obj.currentStore.span.finish()
    return obj.parentStore
  }

  end (ctx) {
    if (ctx.result) {
      ctx.currentStore.span.finish()
    }
  }

  error (ctx) {
    const error = ctx.error
    ctx.currentStore.span.addTag(error)
  }
}

module.exports = AerospikePlugin
