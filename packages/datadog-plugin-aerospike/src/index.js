'use strict'

const { storage } = require('../../datadog-core')
// const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class AerospikePlugin extends DatabasePlugin {
  static get id () { return 'aerospike' }
  static get operation () { return 'query' }
  static get system () { return 'aerospike' }
  // static get prefix () {
  //   return 'tracing:apm:aerospike:command'
  // }
  bindStart (ctx) {
    const { commandName, commandArgs, clientConfig } = ctx
    const resourceName = commandName.slice(0, commandName.indexOf('Command')).toLowerCase()
    const store = storage.getStore()
    const childOf = store ? store.span : null
    let ns

    if (resourceName === 'query') {
      const queryObj = commandArgs[2]
      ns = queryObj.ns
    } else if ((commandArgs && commandArgs[0])) {
      ns = commandArgs[0].ns
    }

    // console.log(100, commandName, commandArgs, clientConfig)
    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.serviceName({ pluginConfig: this.config }),
      type: 'aerospike',
      kind: 'client',
      resource: 'aerospike.' + resourceName,
      meta: {
        'db.name': ns,
        'db.user': clientConfig?.user,
        'out.host': clientConfig?.hosts,
        'out.port': `${clientConfig?.port}`
      }
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
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
    let error = ctx.error
    const span = ctx.currentStore.span
    // console.log(33, span._duration)
    if (!span._spanContext._tags['error']) {
      // Errors may be wrapped in a context.
      error = (error && error.error) || error
      span.setTag('error', error || 1)
    }
    console.log(44)
    // ctx.currentStore.span.setTag('error', error)
  }
}

module.exports = AerospikePlugin
