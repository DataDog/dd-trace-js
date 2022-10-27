'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class SharedbPlugin extends ServerPlugin {
  static get name () { return 'sharedb' }

  start ({ actionName, request }) {
    const span = this.startSpan('sharedb.request', {
      service: this.config.service,
      resource: getReadableResourceName(actionName, request.c, request.q),
      kind: 'server',
      meta: {
        'sharedb.action': actionName
      }
    })

    if (this.config.hooks && this.config.hooks.receive) {
      this.config.hooks.receive(span, request)
    }
  }

  finish ({ request, res }) {
    const span = this.activeSpan
    if (this.config.hooks && this.config.hooks.reply) {
      this.config.hooks.reply(span, request, res)
    }
    span.finish()
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
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

module.exports = SharedbPlugin
