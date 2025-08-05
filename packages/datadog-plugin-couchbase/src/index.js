'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { storage } = require('../../datadog-core')

class CouchBasePlugin extends StoragePlugin {
  static get id () { return 'couchbase' }
  static get peerServicePrecursors () { return ['db.couchbase.seed.nodes'] }

  addBinds (func, start) {
    this.addBind(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:error`, error => this.addError(error))
    this.addSub(`apm:couchbase:${func}:finish`, ctx => this.finish(ctx))
    this.addBind('apm:couchbase:query:callback:start', ctx => {
      ctx.parentStore = storage('legacy').getStore()
      return ctx.parentStore
    })
    this.addBind('apm:couchbase:query:callback:finish', ctx => ctx.parentStore)
  }

  startSpan (operation, customTags, { bucket, collection, seedNodes }, ctx) {
    const tags = {
      'db.type': 'couchbase',
      component: 'couchbase',
      'resource.name': `couchbase.${operation}`,
      'span.kind': this.constructor.kind,
      'db.couchbase.seed.nodes': seedNodes
    }

    if (bucket) tags['couchbase.bucket.name'] = bucket.name
    if (collection) tags['couchbase.collection.name'] = collection.name

    for (const tag in customTags) {
      tags[tag] = customTags[tag]
    }

    return super.startSpan(
      this.operationName({ operation }),
      {
        service: this.serviceName({ pluginConfig: this.config }),
        meta: tags
      },
      ctx
    )
  }

  constructor (...args) {
    super(...args)

    this.addBinds('query', (ctx) => {
      const { resource, bucket, seedNodes } = ctx

      this.startSpan(
        'query',
        {
          'span.type': 'sql',
          'resource.name': resource,
          'span.kind': this.constructor.kind
        },
        { bucket, seedNodes },
        ctx
      )

      return ctx.currentStore
    })

    this._addCommandSubs('upsert')
    this._addCommandSubs('insert')
    this._addCommandSubs('replace')
    this._addCommandSubs('append')
    this._addCommandSubs('prepend')
  }

  _addCommandSubs (name) {
    this.addBinds(name, (ctx) => {
      const { bucket, collection, seedNodes } = ctx

      const span = this.startSpan(name, {}, { bucket, collection, seedNodes }, ctx)
      this.enter(span, ctx.currentStore)
    })
  }
}

module.exports = CouchBasePlugin
