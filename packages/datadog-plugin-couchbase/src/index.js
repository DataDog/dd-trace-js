'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')

class CouchBasePlugin extends StoragePlugin {
  static id = 'couchbase'
  static peerServicePrecursors = ['db.couchbase.seed.nodes']

  constructor (...args) {
    super(...args)

    this.#addOpSubs('query', (ctx) => {
      const { resource, bucket, seedNodes } = ctx
      this.startSpan(
        'query',
        {
          'span.type': 'sql',
          'resource.name': resource,
          'span.kind': this.constructor.kind,
        },
        { bucket, seedNodes },
        ctx
      )
      return ctx.currentStore
    })

    for (const op of ['upsert', 'insert', 'replace']) {
      this.#addOpSubs(op, (ctx) => {
        const { bucket, collection, seedNodes } = ctx
        this.startSpan(op, {}, { bucket, collection, seedNodes }, ctx)
        return ctx.currentStore
      })
    }
  }

  /**
   * @param {string} op Operation name (`query`, `upsert`, ...).
   * @param {(ctx: object) => object} bindStart Operation-specific span starter.
   */
  #addOpSubs (op, bindStart) {
    const prefix = `tracing:apm:couchbase:${op}`
    this.addBind(`${prefix}:start`, bindStart)
    this.addBind(`${prefix}:asyncStart`, bindAsyncStart)
    this.addSub(`${prefix}:asyncEnd`, finishSpan)
    this.addSub(`${prefix}:end`, finishSpanIfSync)
    this.addSub(`${prefix}:error`, setSpanError)
  }

  startSpan (operation, customTags, { bucket, collection, seedNodes }, ctx) {
    const tags = {
      'db.type': 'couchbase',
      component: 'couchbase',
      'resource.name': `couchbase.${operation}`,
      'span.kind': this.constructor.kind,
      'db.couchbase.seed.nodes': seedNodes,
    }

    if (bucket) tags['couchbase.bucket.name'] = bucket.name
    if (collection) tags['couchbase.collection.name'] = collection.name

    for (const key of Object.keys(customTags)) {
      tags[key] = customTags[key]
    }

    return super.startSpan(
      this.operationName({ operation }),
      {
        service: this.serviceName({ pluginConfig: this.config }),
        meta: tags,
      },
      ctx
    )
  }
}

function bindAsyncStart (ctx) {
  return ctx.parentStore
}

function finishSpan (ctx) {
  ctx.currentStore?.span?.finish()
}

// `end` fires synchronously after the wrapped function returns. For async
// resolutions ctx.result and ctx.error are still unset at that point and the
// span is closed later via asyncEnd. For a sync throw or sync-resolved
// callback, this is the only finalization signal.
function finishSpanIfSync (ctx) {
  if ((ctx.error !== undefined || ctx.result !== undefined) && ctx.currentStore?.span) {
    ctx.currentStore.span.finish()
  }
}

function setSpanError (ctx) {
  if (ctx.error && ctx.currentStore?.span) {
    ctx.currentStore.span.setTag('error', ctx.error)
  }
}

module.exports = CouchBasePlugin
