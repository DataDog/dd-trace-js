'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class CouchbasePlugin extends Plugin {
  static get name () {
    return 'couchbase'
  }

  addSubs (func, start) {
    this.addSub(`apm:couchbase:${func}:start`, start)
    this.addSub(`apm:couchbase:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:couchbase:${func}:error`, this.addError.bind(this))
    this.addSub(`apm:couchbase:${func}:async-end`, this.finishSpan.bind(this))
  }

  startSpan (operation, bucket, type, resource) {
    return super.startSpan(`couchbase.${operation}`, {
      service: this.config.service || `${this.tracer._service}-couchbase`,
      resource,
      type,
      kind: 'client',
      meta: {
        'db.type': 'couchbase',
        'component': 'couchbase',
        'couchbase.bucket.name': bucket.name || bucket._name
      }
    })
  }

  constructor (...args) {
    super(...args)

    this.addSubs('query', ({ resource, bucket }) => {
      this.startSpan('query', bucket, 'sql', resource)
    })

    this._addCommandSubs('upsert')
    this._addCommandSubs('insert')
    this._addCommandSubs('replace')
    this._addCommandSubs('append')
    this._addCommandSubs('prepend')
  }

  _addCommandSubs (name) {
    this.addSubs(name, ({ bucket }) => {
      this.startSpan(name, bucket)
    })
  }
}

module.exports = CouchbasePlugin
