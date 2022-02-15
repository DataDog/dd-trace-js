'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class SharedbPlugin extends Plugin {
  static get name () {
    return 'sharedb'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:sharedb:_handleMessage:start`, ({ actionName, request }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('sharedb.request', {
        childOf,
        tags: {
          'service.name': this.config.service || this.tracer._service,
          'span.kind': 'server',
          'sharedb.action': actionName,
          'resource.name': getReadableResourceName(actionName, request.c, request.q)
        }
      })

      if (this.config.hooks && this.config.hooks.receive) {
        this.config.hooks.receive(span, request)
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:sharedb:_handleMessage:end`, () => {
      this.exit()
    })

    this.addSub(`apm:sharedb:_handleMessage:error`, err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub(`apm:sharedb:_handleMessage:async-end`, ({ request, res }) => {
      const span = storage.getStore().span
      if (this.config.hooks && this.config.hooks.reply) {
        this.config.hooks.reply(span, request, res)
      }
      span.finish()
    })
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
