'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk')) {
  addHook(hook, exports => exports)
}

// Start / finish channels for the server-side request lifecycle.
// We cannot use orchestrion for Protocol._onrequest: it returns void and schedules all
// async work via an internal Promise chain that is not returned. kind:'Async' would await
// undefined and close immediately; kind:'Sync' closes before any handler runs.
//
// Instead we detect the request lifecycle via Protocol._requestHandlerAbortControllers:
//   set(request.id, controller)  — called synchronously at the start of _onrequest
//   delete(request.id)           — called in .finally() when the full Promise chain completes
//
// The shimmer intercepts _onrequest to publish the start channel (establishing async context)
// and wraps the per-instance _requestHandlerAbortControllers.delete to publish finish.
const serverRequestStartCh = channel('apm:mcp:server:request:start')
const serverRequestFinishCh = channel('apm:mcp:server:request:finish')
const serverRequestErrorCh = channel('apm:mcp:server:request:error')

function wrapProtocol (Protocol) {
  shimmer.wrap(Protocol.prototype, '_onrequest', function (original) {
    return function _onrequestWithTrace (request, extra) {
      if (!serverRequestStartCh.hasSubscribers) {
        return original.call(this, request, extra)
      }

      // Wrap _requestHandlerAbortControllers.delete once per Protocol instance so we know
      // when the full async Promise chain for a given request completes (success or error).
      // We must do this before calling original, because original calls .set() synchronously,
      // and we need the delete wrapper ready before .finally() fires.
      const abortControllersMap = this._requestHandlerAbortControllers
      if (abortControllersMap && !abortControllersMap._ddWrapped) {
        abortControllersMap._ddWrapped = true
        const originalDelete = Map.prototype.delete.bind(abortControllersMap)
        const instance = this
        abortControllersMap.delete = function (id) {
          const pendingCtx = instance._ddPendingRequests?.get(id)
          if (pendingCtx) {
            instance._ddPendingRequests.delete(id)
            serverRequestFinishCh.publish(pendingCtx)
          }
          return originalDelete(id)
        }
      }

      // Register the ctx before calling original so the delete hook can find it.
      if (!this._ddPendingRequests) {
        this._ddPendingRequests = new Map()
      }

      const ctx = { request, extra, requestId: request.id, instance: this }
      this._ddPendingRequests.set(request.id, ctx)

      // runStores establishes the async context (span store) for this request. The entire
      // internal Promise chain created by original() inherits this async context so that
      // child spans (e.g. mcp.server.tool.call) are correctly parented.
      return serverRequestStartCh.runStores(ctx, () => {
        return original.call(this, request, extra)
      })
    }
  })

  return Protocol
}

// Wire up shimmer for both ESM and CJS builds of protocol.js.
// Orchestrion is not viable here: _onrequest is fire-and-forget and the static AST
// rewriter cannot express the split start/finish lifecycle needed (see comment above).
addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/cjs/shared/protocol.js',
}, exports => {
  wrapProtocol(exports.Protocol)
  return exports
})

addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/esm/shared/protocol.js',
}, exports => {
  wrapProtocol(exports.Protocol)
  return exports
})
