'use strict'

function subscribeTraceSync (plugin, chName, startHandler, errorHandler, endHandler) {
  plugin.addBind(chName + ':start', ctx => plugin[startHandler](ctx))
  plugin.addSub(chName + ':error', ctx => errorHandler ? plugin[errorHandler](ctx) : plugin.error(ctx))
  plugin.addSub(chName + ':end', ctx => endHandler ? plugin[endHandler](ctx) : plugin.finish(ctx))
}

function subscribeTracePromise (plugin, chName, startHandler, errorHandler, endHandler) {
  plugin.addBind(chName + ':start', ctx => plugin[startHandler](ctx))
  plugin.addSub(chName + ':error', ctx => errorHandler ? plugin[errorHandler](ctx) : plugin.error(ctx))
  plugin.addSub(chName + ':asyncEnd', ctx => endHandler ? plugin[endHandler](ctx) : plugin.finish(ctx))
}

function subscribeTraceCallback (plugin, chName, startHandler, errorHandler, endHandler) {
  plugin.addBind(chName + ':asyncStart', ctx => plugin[startHandler](ctx))
  plugin.addSub(chName + ':error', ctx => errorHandler ? plugin[errorHandler](ctx) : plugin.error(ctx))
  plugin.addSub(chName + ':asyncEnd', ctx => endHandler ? plugin[endHandler](ctx) : plugin.finish(ctx))
}

module.exports = {
  subscribeTraceSync,
  subscribeTracePromise,
  subscribeTraceCallback
}
