'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

// Load rewriter-based instrumentation for invoke()
// The orchestrion rewriter instruments Pregel.invoke() via the hooks defined in
// packages/datadog-instrumentations/src/helpers/hooks.js
for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, exports => exports)
}

// Shimmer-based instrumentation for stream()
// stream() cannot use the orchestrion rewriter because the method uses super.stream()
// which causes issues with the rewriter transformation
const startCh = channel('apm:langgraph:stream:start')
const asyncEndCh = channel('apm:langgraph:stream:asyncEnd')
const errorCh = channel('apm:langgraph:stream:error')

function wrapStream (stream) {
  return function (input, options) {
    if (!startCh.hasSubscribers) {
      return stream.apply(this, arguments)
    }

    const ctx = {
      args: [input, options],
      self: this
    }

    startCh.publish(ctx)

    try {
      const promise = stream.apply(this, arguments)

      return promise
        .then(result => {
          ctx.result = result
          asyncEndCh.publish(ctx)
          return result
        })
        .catch(error => {
          ctx.error = error
          errorCh.publish(ctx)
          asyncEndCh.publish(ctx)
          throw error
        })
    } catch (error) {
      ctx.error = error
      errorCh.publish(ctx)
      asyncEndCh.publish(ctx)
      throw error
    }
  }
}

addHook({
  name: '@langchain/langgraph',
  versions: ['>=1.0.15']
}, exports => {
  const CompiledStateGraph = exports.CompiledStateGraph
  if (!CompiledStateGraph) return exports

  // Find the prototype where stream is defined (Pregel)
  let proto = CompiledStateGraph.prototype
  while (proto && !Object.hasOwn(proto, 'stream')) {
    proto = Object.getPrototypeOf(proto)
  }

  if (proto && typeof proto.stream === 'function') {
    shimmer.wrap(proto, 'stream', wrapStream)
  }

  return exports
})
