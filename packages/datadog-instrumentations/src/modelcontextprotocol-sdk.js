'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk')) {
  addHook(hook, exports => exports)
}

// _onrequest is fire-and-forget (returns void, async work runs in an internal Promise chain).
// Lifecycle is tracked via _requestHandlerAbortControllers: .set() fires at request start,
// .delete() fires in .finally() when the chain completes.
const serverRequestStartCh = channel('apm:mcp:server:request:start')
const serverRequestFinishCh = channel('apm:mcp:server:request:finish')

// WeakMap keyed by Protocol instance — pending request contexts, keyed internally by request.id.
const pendingRequests = new WeakMap()

function wrapProtocol (Protocol) {
  shimmer.wrap(Protocol.prototype, '_onrequest', function (original) {
    return function _onrequestWithTrace (request, extra) {
      if (!serverRequestStartCh.hasSubscribers) {
        return original.call(this, request, extra)
      }

      // Wrap _requestHandlerAbortControllers.delete and .clear once per instance to detect
      // completion. .delete() fires in .finally() when a request chain completes normally.
      // .clear() fires from _onclose() when the transport disconnects with requests in flight.
      const abortControllersMap = this._requestHandlerAbortControllers
      if (abortControllersMap && !abortControllersMap._ddWrapped) {
        abortControllersMap._ddWrapped = true
        const originalDelete = Map.prototype.delete.bind(abortControllersMap)
        const originalClear = Map.prototype.clear.bind(abortControllersMap)
        const instance = this

        abortControllersMap.delete = function (id) {
          const pending = pendingRequests.get(instance)
          const ctx = pending?.get(id)
          if (ctx) {
            pending.delete(id)
            serverRequestFinishCh.publish(ctx)
          }
          return originalDelete(id)
        }

        // Called by _onclose() when the transport disconnects — finish all in-flight spans.
        abortControllersMap.clear = function () {
          const pending = pendingRequests.get(instance)
          if (pending) {
            for (const ctx of pending.values()) {
              serverRequestFinishCh.publish(ctx)
            }
            pending.clear()
          }
          originalClear()
        }
      }

      if (!pendingRequests.has(this)) {
        pendingRequests.set(this, new Map())
      }

      const ctx = { request, extra, requestId: request.id }
      pendingRequests.get(this).set(request.id, ctx)

      return serverRequestStartCh.runStores(ctx, () => {
        const result = original.call(this, request, extra)

        // If the SDK found no handler for this method, it returns without registering an
        // AbortController. The span will never be finished via .delete()/.clear(), so finish
        // it immediately here.
        if (!abortControllersMap?.has(request.id)) {
          const pending = pendingRequests.get(this)
          if (pending?.has(request.id)) {
            pending.delete(request.id)
            serverRequestFinishCh.publish(ctx)
          }
        }

        return result
      })
    }
  })

  return Protocol
}

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
