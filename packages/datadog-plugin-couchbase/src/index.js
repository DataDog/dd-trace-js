'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class CouchBasePlugin extends Plugin {
  static get name () {
    return 'couchbase'
  }

  addSubs (func, start, finish = defaultFinish) {
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:error`, this.addError)
    this.addSub(`apm:couchbase:${func}:finish`, finish)
  }

  startSpan (operation, customTags, store, { bucket, collection }) {
    const tags = {
      'db.type': 'couchbase',
      'component': 'couchbase',
      'service.name': this.config.service || `${this.tracer._service}-couchbase`,
      'resource.name': `couchbase.${operation}`,
      'span.kind': 'client'
    }

    for (const tag in customTags) {
      tags[tag] = customTags[tag]
    }
    const span = this.tracer.startSpan(`couchbase.${operation}`, {
      childOf: store ? store.span : null,
      tags
    })

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

function defaultFinish () {
  storage.getStore().span.finish()
}

module.exports = CouchBasePlugin
