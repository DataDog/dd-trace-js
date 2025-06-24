'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class SharedbPlugin extends ServerPlugin {
  static get id () { return 'sharedb' }

  bindStart (ctx) {
    const { actionName, request } = ctx

    const span = this.startSpan('sharedb.request', {
      service: this.config.service,
      resource: getReadableResourceName(actionName, request.c, request.q),
      kind: 'server',
      meta: {
        'sharedb.action': actionName
      }
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
    readableActionName += ' ' + JSON.stringify(sanitize(query))
  }
  return readableActionName
}

function sanitize (input) {
  const output = {}

  if (!isObject(input) || Buffer.isBuffer(input)) return '?'

  for (const key in input) {
    if (typeof input[key] === 'function') continue

    output[key] = sanitize(input[key])
  }

  return output
}

function isObject (val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

module.exports = SharedbPlugin
