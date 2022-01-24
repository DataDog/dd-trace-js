'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class CouchBasePlugin extends Plugin {
  static get name () {
    return 'couchbase'
  }
  
  addSubs (func, start, asyncEnd = defaultAsyncEnd) {
    // debugger;
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:couchbase:${func}:error`, errorHandler)
    this.addSub(`apm:couchbase:${func}:async-end`, asyncEnd)
  }

  startSpan (operation, customTags, store, bucket) {
    debugger;
    const tags = {
      'db.type': 'couchbase',
      'component': 'couchbase',
      'service.name': this.config.service || `${this.tracer._service}-couchbase`,
      'resource.name': operation,
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

    this.addSub('apm:couchbase:_n1qlReq:start', ([resource, conf, bucket]) => {
      debugger;
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('couchbase.query', {
        childOf,
        tags: {
          'db.type': 'couchbase',
          'component': 'couchbase',
          'service.name': this.config.service || `${this.tracer._service}-couchbase`,
          'resource.name': resource,
        }
      })

      span.setTag('span.type', 'sql')
      span.setTag('couchbase.bucket.name', bucket.name || bucket._name)

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:couchbase:_n1qlReq:end', () => {
      debugger;
      this.exit()
    })

    this.addSub('apm:couchbase:_n1qlReq:error', err => {
      debugger;
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })

    this.addSub('apm:couchbase:_n1qlReq:async-end', () => {
      debugger;
      const span = storage.getStore().span
      span.finish()
    })

    this.addSubs('upsert', ([bucket]) => {
      debugger;
      const store = storage.getStore()
      const span = this.startSpan('upsert', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('insert', ([bucket]) => {
      debugger;
      const store = storage.getStore()
      const span = this.startSpan('insert', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('replace', ([bucket]) => {
      debugger;
      const store = storage.getStore()
      const span = this.startSpan('replace', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('append', ([bucket]) => {
      debugger;
      const store = storage.getStore()
      const span = this.startSpan('append', {}, store, bucket)
      this.enter(span, store)
    })

    this.addSubs('prepend', ([bucket]) => {
      debugger;
      const store = storage.getStore()
      const span = this.startSpan('prepend', {}, store, bucket)
      this.enter(span, store)
    })
  }
}

function defaultAsyncEnd () {
  debugger;
  storage.getStore().span.finish()
}

function errorHandler (error) {
  debugger;
  storage.getStore().span.setTag('error', error)
}

module.exports = CouchBasePlugin
