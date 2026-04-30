'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class SharedbPlugin extends ServerPlugin {
  static id = 'sharedb'

  bindStart (ctx) {
    const { actionName, request } = ctx

    const span = this.startSpan('sharedb.request', {
      service: this.config.service,
      resource: getReadableResourceName(actionName, request.c, request.q),
      kind: 'server',
      meta: {
        'sharedb.action': actionName,
      },
    }, ctx)

    if (this.config.hooks && this.config.hooks.receive) {
      this.config.hooks.receive(span, request)
    }

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const { request, res } = ctx

    const span = ctx.currentStore.span
    if (this.config.hooks && this.config.hooks.reply) {
      this.config.hooks.reply(span, request, res)
    }
    super.finish(ctx)

    return ctx.parentStore
  }
}

function getReadableResourceName (readableActionName, collection, query) {
  if (collection) {
    readableActionName += ' ' + collection
  }
  if (query) {
    readableActionName += ' ' + JSON.stringify(query, sanitiseReplacer)
  }
  return readableActionName
}

// Folds the previous recursive `sanitize` clone into a JSON.stringify replacer: non-plain
// values become '?', nested functions drop, plain objects walk natively without an intermediate copy.
function sanitiseReplacer (key, value) {
  if (typeof value === 'function') {
    return key === '' ? '?' : undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    return '?'
  }
  return value
}

module.exports = SharedbPlugin
