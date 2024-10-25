'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { storage } = require('../../datadog-core')

class CouchBasePlugin extends StoragePlugin {
  static get id () { return 'couchbase' }
  static get peerServicePrecursors () { return ['db.couchbase.seed.nodes'] }

  addSubs (func, start) {
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:error`, error => this.addError(error))
    this.addSub(`apm:couchbase:${func}:finish`, message => this.finish(message))
  }

  startSpan (operation, customTags, store, { bucket, collection, seedNodes }) {
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
      }
    )
  }

  constructor (...args) {
    super(...args)

    this.addSubs('query', ({ resource, bucket, seedNodes }) => {
      const store = storage.getStore()
      const span = this.startSpan(
        'query', {
          'span.type': 'sql',
          'resource.name': resource,
          'span.kind': this.constructor.kind
        },
        store,
        { bucket, seedNodes }
      )
      this.enter(span, store)
    })

    this._addCommandSubs('upsert')
    this._addCommandSubs('insert')
    this._addCommandSubs('replace')
    this._addCommandSubs('append')
    this._addCommandSubs('prepend')
  }

  _addCommandSubs (name) {
    this.addSubs(name, ({ bucket, collection, seedNodes }) => {
      const store = storage.getStore()
      const span = this.startSpan(name, {}, store, { bucket, collection, seedNodes })
      this.enter(span, store)
    })
  }
}

module.exports = CouchBasePlugin
