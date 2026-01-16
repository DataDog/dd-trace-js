'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

// Load rewriter-based instrumentation for invoke()
// The orchestrion rewriter instruments Pregel.invoke() via the hooks defined in
// packages/datadog-instrumentations/src/helpers/hooks.js
for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, exports => exports)
}

// Shimmer-based instrumentation for stream()
// stream() cannot use the orchestrion rewriter because the method uses super.stream()
// which causes issues with the rewriter transformation
const streamTracingChannel = tracingChannel('apm:langgraph:stream')

function wrapStream (stream) {
  return function (input, options) {
    if (!streamTracingChannel.start.hasSubscribers) {
      return stream.apply(this, arguments)
    }

    const ctx = {
      args: [input, options],
      self: this
    }

    return streamTracingChannel.start.runStores(ctx, () => {
      let promise
      try {
        promise = stream.apply(this, arguments)
      } catch (error) {
        ctx.error = error
        streamTracingChannel.error.publish(ctx)
        streamTracingChannel.asyncEnd.publish(ctx)
        throw error
      } finally {
        streamTracingChannel.end.publish(ctx)
      }

      return promise
        .then(result => {
          ctx.result = result
          streamTracingChannel.asyncEnd.publish(ctx)
          return result
        })
        .catch(error => {
          ctx.error = error
          streamTracingChannel.error.publish(ctx)
          streamTracingChannel.asyncEnd.publish(ctx)
          throw error
        })
    })
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
