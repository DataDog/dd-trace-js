'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
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
const onStreamedChunkCh = channel('apm:langgraph:stream:chunk')

/**
 * Wraps the async iterator to publish chunks as they're consumed.
 */
function wrapStreamIterator (iterator, ctx) {
  return function () {
    const itr = iterator.apply(this, arguments)
    shimmer.wrap(itr, 'next', next => function () {
      return next.apply(this, arguments)
        .then(res => {
          const { done, value: chunk } = res
          onStreamedChunkCh.publish({ ctx, chunk, done })

          if (done) {
            // Stream completed - publish asyncEnd
            streamTracingChannel.asyncEnd.publish(ctx)
          }

          return res
        })
        .catch(error => {
          ctx.error = error
          streamTracingChannel.error.publish(ctx)
          streamTracingChannel.asyncEnd.publish(ctx)
          throw error
        })
    })

    return itr
  }
}

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
          // Wrap the iterator to track chunks
          if (result[Symbol.asyncIterator]) {
            shimmer.wrap(result, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
          } else {
            // Not a stream, just set the result
            ctx.result = result
            streamTracingChannel.asyncEnd.publish(ctx)
          }
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
