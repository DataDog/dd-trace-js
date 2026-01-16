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

function finish (ctx, error) {
  if (error) {
    ctx.error = error
    streamTracingChannel.error.publish(ctx)
  }
  streamTracingChannel.asyncEnd.publish(ctx)
}

function wrapStreamIterator (iterator, ctx) {
  return function () {
    const itr = iterator.apply(this, arguments)

    // Track chunks for aggregation
    ctx.chunks = ctx.chunks || []

    shimmer.wrap(itr, 'next', next => function () {
      return next.apply(this, arguments)
        .then(res => {
          const { done, value: chunk } = res

          // Publish chunk event for LLMObs
          onStreamedChunkCh.publish({ ctx, chunk, done })

          if (chunk) {
            ctx.chunks.push(chunk)
          }

          if (done) {
            // Aggregate chunks into final result for the tracing plugin
            // LangGraph chunks are objects like { nodeName: stateUpdate }
            ctx.result = aggregateChunks(ctx.chunks)
            finish(ctx)
          }

          return res
        })
        .catch(error => {
          ctx.error = error
          finish(ctx, error)
          throw error
        })
    })

    return itr
  }
}

/**
 * Aggregate LangGraph stream chunks into final state.
 * Each chunk is { nodeName: { stateKey: value, ... } }
 */
function aggregateChunks (chunks) {
  const finalState = {}
  for (const chunk of chunks) {
    for (const nodeOutput of Object.values(chunk)) {
      if (nodeOutput && typeof nodeOutput === 'object') {
        Object.assign(finalState, nodeOutput)
      }
    }
  }
  return finalState
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
        finish(ctx, error)
        throw error
      } finally {
        streamTracingChannel.end.publish(ctx)
      }

      return promise
        .then(result => {
          // LangGraph stream() returns an async iterator
          if (result && result[Symbol.asyncIterator]) {
            shimmer.wrap(result, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
          } else {
            // Unexpected - finish immediately
            ctx.result = result
            finish(ctx)
          }
          return result
        })
        .catch(error => {
          ctx.error = error
          finish(ctx, error)
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
