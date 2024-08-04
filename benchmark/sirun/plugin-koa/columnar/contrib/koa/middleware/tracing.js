'use strict'

const { tracingChannel } = require('diagnostics_channel')
const { storage } = require('../../../storage')
const { exporter } = require('../../../exporter')

const ch = tracingChannel('apm:koa:request')

class KoaTracingMiddleware {
  constructor () {
    this._subscribers = {
      start: ({ req }) => {
        const spanContext = storage.getStore()

        exporter.webRequestStart(req, 'koa', spanContext)
      },

      asyncStart: ({ res }) => {
        const spanContext = storage.getStore()

        exporter.webRequestFinish(res, spanContext)
      },

      error: ({ res }) => {
        const spanContext = storage.getStore()

        exporter.webRequestFinish(res, spanContext)
      }
    }
  }

  enable () {
    ch.subscribe(this._subscribers)
  }

  disable () {
    ch.unsubscribe(this._subscribers)
  }
}

module.exports = new KoaTracingMiddleware()
