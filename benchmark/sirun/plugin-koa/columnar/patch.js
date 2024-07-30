'use strict'

const { tracingChannel } = require('diagnostics_channel')
const Hook = require('../../../../packages/dd-trace/src/ritm')

const ch = tracingChannel('apm:koa:request')

Hook(['koa'], function (Koa, name, basedir) {
  if (name !== 'koa/lib/application.js') return Koa

  const { handleRequest } = Koa.prototype

  Koa.prototype.handleRequest = function (ctx, ...args) {
    return ch.tracePromise(handleRequest, ctx, Koa.prototype, ctx, ...args)
  }

  return Koa
})
