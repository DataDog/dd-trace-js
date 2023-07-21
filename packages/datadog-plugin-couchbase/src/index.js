'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class CouchBasePlugin extends StoragePlugin {
  static get id () {
    return 'couchbase'
  }

  addSubs (func, start) {
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:error`, error => this.addError(error))
    this.addSub(`apm:couchbase:${func}:finish`, message => this.finish(message))
  }

  startSpan (operation, customTags, store, { bucket, collection }) {
    const tags = {
      'db.type': 'couchbase',
      'component': 'couchbase',
      'service.name': this.serviceName({ pluginConfig: this.config }),
      'resource.name': `couchbase.${operation}`,
      'span.kind': this.constructor.kind
    }

    for (const tag in customTags) {
      tags[tag] = customTags[tag]
    }
    const span = this.tracer.startSpan(
      this.operationName({ operation }),
      {
        childOf: store ? store.span : null,
        tags
      }
    )

    if (bucket) span.setTag(`couchbase.bucket.name`, bucket.name)
    if (collection) span.setTag(`couchbase.collection.name`, collection.name)

    analyticsSampler.sample(span, this.config.measured)
    return span
  }

  constructor (...args) {
    super(...args)

    this.addSubs('query', ({ resource, bucket }) => {
      const store = storage.getStore()
      const span = this.startSpan('query', { 'span.type': 'sql', 'resource.name': resource },
        store, { bucket })
      this.enter(span, store)
    })

    this._addCommandSubs('upsert')
    this._addCommandSubs('insert')
    this._addCommandSubs('replace')
    this._addCommandSubs('append')
    this._addCommandSubs('prepend')
  }
  _addCommandSubs (name) {
    this.addSubs(name, ({ bucket, collection }) => {
      const store = storage.getStore()
      const span = this.startSpan(name, {}, store, { bucket, collection })
      this.enter(span, store)
    })
  }
}

module.exports = CouchBasePlugin
