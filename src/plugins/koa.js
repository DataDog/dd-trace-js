'use strict'

const web = require('./util/web')

function createWrapUse (tracer, config) {
  config = web.normalizeConfig(config)

  function ddTrace (ctx, next) {
    if (web.active(ctx.req)) return next()

    web.instrument(tracer, config, ctx.req, ctx.res, 'koa.request')

    return next()
      .then(() => extractRoute(ctx))
      .catch(e => {
        extractRoute(ctx)
        return Promise.reject(e)
      })
  }

  return function wrapUse (use) {
    return function useWithTrace (fn) {
      if (!this._datadog_trace_patched) {
        this._datadog_trace_patched = true
        use.call(this, ddTrace)
      }

      return use.call(this, function (ctx, next) {
        web.reactivate(ctx.req)
        return fn.apply(this, arguments)
      })
    }
  }
}

function extractRoute (ctx) {
  if (ctx.matched) {
    ctx.matched
      .filter(layer => layer.methods.length > 0)
      .forEach(layer => {
        web.enterRoute(ctx.req, layer.path)
      })
  }
}

module.exports = [
  {
    name: 'koa',
    versions: ['2.x'],
    patch (Koa, tracer, config) {
      this.wrap(Koa.prototype, 'use', createWrapUse(tracer, config))
    },
    unpatch (Koa) {
      this.unwrap(Koa.prototype, 'use')
    }
  }
]
