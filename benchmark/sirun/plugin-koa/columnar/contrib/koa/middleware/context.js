'use strict'

const { tracingChannel } = require('diagnostics_channel')
const { storage } = require('../../../storage')
const { SpanContext } = require('../../../context')

const ch = tracingChannel('apm:koa:request')

class KoaContextMiddleware {
  constructor () {
    this._transform = () => new SpanContext()
  }

  enable () {
    ch.start.bindStore(storage, this._transform)
  }

  disable () {
    ch.unsubscribe(this._subscribers)
  }
}

module.exports = new KoaContextMiddleware()
