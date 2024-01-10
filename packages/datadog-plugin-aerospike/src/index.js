'use strict'

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

const AEROSPIKE_PEER_SERVICE = 'aerospike.namespace'

class AerospikePlugin extends DatabasePlugin {
  static get id () { return 'aerospike' }
  static get operation () { return 'command' }
  static get system () { return 'aerospike' }
  static get prefix () {
    return 'tracing:apm:aerospike:command'
  }

  static get peerServicePrecursors () {
    return [AEROSPIKE_PEER_SERVICE]
  }

  bindStart (ctx) {
    const { commandName, commandArgs } = ctx
    const resourceName = commandName.slice(0, commandName.indexOf('Command'))
    const store = storage.getStore()
    const childOf = store ? store.span : null
    const meta = getMeta(resourceName, commandArgs)

    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.serviceName({ pluginConfig: this.config }),
      type: 'aerospike',
      kind: 'client',
      resource: resourceName,
      meta
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    if (ctx.currentStore) {
      // have to manually trigger peer service calculation when using tracing channel
      this.tagPeerService(ctx.currentStore.span)
      ctx.currentStore.span.finish()
    }
    return ctx.parentStore
  }

  end (ctx) {
    if (ctx.result) {
      // have to manually trigger peer service calculation when using tracing channel
      this.tagPeerService(ctx.currentStore.span)
      ctx.currentStore.span.finish()
    }
  }

  error (ctx) {
    if (ctx.error) {
      const error = ctx.error
      const span = ctx.currentStore.span
      span.setTag('error', error)
    }
  }
}

function getMeta (resourceName, commandArgs) {
  let meta = {}
  if (resourceName.includes('Index')) {
    const [ns, set, bin, index] = commandArgs
    meta = getMetaForIndex(ns, set, bin, index)
  } else if (resourceName === 'Query') {
    const { ns, set } = commandArgs[2]
    meta = getMetaForQuery({ ns, set })
  } else if (isKeyObject(commandArgs[0])) {
    const { ns, set, key } = commandArgs[0]
    meta = getMetaForKey(ns, set, key)
  }
  return meta
}

function getMetaForIndex (ns, set, bin, index) {
  return {
    [AEROSPIKE_PEER_SERVICE]: ns,
    'aerospike.setname': set,
    'aerospike.bin': bin,
    'aerospike.index': index
  }
}

function getMetaForKey (ns, set, key) {
  return {
    'aerospike.key': `${ns}:${set}:${key}`,
    [AEROSPIKE_PEER_SERVICE]: ns,
    'aerospike.setname': set,
    'aerospike.userkey': key
  }
}

function getMetaForQuery (queryObj) {
  const { ns, set } = queryObj
  return {
    [AEROSPIKE_PEER_SERVICE]: ns,
    'aerospike.setname': set
  }
}

function isKeyObject (obj) {
  return obj && obj.ns !== undefined && obj.set !== undefined && obj.key !== undefined
}

module.exports = AerospikePlugin
