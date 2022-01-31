'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class CouchBasePlugin extends Plugin {
  static get name () {
    return 'couchbase'
  }

  addSubs (func, start, asyncEnd = defaultAsyncEnd) {
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:couchbase:${func}:error`, errorHandler)
    this.addSub(`apm:couchbase:${func}:async-end`, asyncEnd)
  }

  startSpan (operation, customTags, store, bucket) {
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

    span.setTag('couchbase.bucket.name', bucket.name || bucket._name)

    analyticsSampler.sample(span, this.config.measured)
    return span
  }

  constructor (...args) {
    super(...args)

    this.addSubs('_n1qlReq', ([resource, bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('query', { 'span.type': 'sql', 'resource.name': resource }, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('upsert', ([bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('upsert', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('insert', ([bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('insert', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('replace', ([bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('replace', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('append', ([bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('append', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('prepend', ([bucket]) => {
      const store = storage.getStore()
      const span = this.startSpan('prepend', {}, store, bucket)
      this.enter(span, store)
    })
  }
}

function defaultAsyncEnd () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  storage.getStore().span.setTag('error', error)
}

module.exports = CouchBasePlugin
