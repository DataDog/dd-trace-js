'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

// Load rewriter-based instrumentation for invoke()
for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, exports => exports)
}

// Shimmer-based instrumentation for stream() method
// The stream() method cannot use the rewriter because it uses `super.stream()`
// which breaks when the rewriter transforms the method.
const streamTracingChannel = tracingChannel('apm:langchain-langgraph:stream')

function wrapStreamIterator (iterator, ctx) {
  return function () {
    const itr = iterator.apply(this, arguments)
    shimmer.wrap(itr, 'next', next => function () {
      return next.apply(this, arguments)
        .then(res => {
          const { done, value: chunk } = res

          // Accumulate chunks to reconstruct final state
          if (chunk) {
            ctx.chunks = ctx.chunks || []
            ctx.chunks.push(chunk)
          }

          if (done) {
            // Reconstruct final state from chunks
            ctx.result = reconstructFinalState(ctx.chunks)
            finish(ctx)
          }

          return res
        })
        .catch(error => {
          finish(ctx, error)
          throw error
        })
    })

    return itr
  }
}

function reconstructFinalState (chunks) {
  if (!chunks || chunks.length === 0) {
    return null
  }

  // LangGraph streams state updates as objects like { nodeName: { ...state } }
  // We need to merge all chunks to get the final state
  let finalState = {}

  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      // Each chunk is typically { nodeName: stateUpdate }
      // We merge all updates to reconstruct final state
      for (const [key, value] of Object.entries(chunk)) {
        if (value && typeof value === 'object') {
          finalState = { ...finalState, ...value }
        }
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
      self: this,
      chunks: []
    }

    return streamTracingChannel.start.runStores(ctx, () => {
      let streamPromise
      try {
        streamPromise = stream.apply(this, arguments)
      } catch (error) {
        ctx.error = error
        streamTracingChannel.error.publish(ctx)
        streamTracingChannel.asyncEnd.publish(ctx)
        throw error
      }

      // The stream() method returns a promise that resolves to an async iterable
      return streamPromise
        .then(response => {
          // Wrap the async iterator to capture chunks
          shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
          streamTracingChannel.end.publish(ctx)
          return response
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

function finish (ctx, error) {
  if (error) {
    ctx.error = error
    streamTracingChannel.error.publish(ctx)
  }

  streamTracingChannel.asyncEnd.publish(ctx)
}

// NOTE: This hook attempts to wrap the stream() method on Pregel, but it doesn't work
// because LangGraph's bundled code uses internal relative requires (e.g., require('../pregel/index.cjs'))
// that bypass the hook system. The hook pattern matches when the module is required directly
// by user code, but not when it's required internally by the bundle.
// This code is kept here for documentation purposes and in case the bundling changes.
// Streaming instrumentation needs a different approach - potentially patching at the library level.
addHook({
  name: '@langchain/langgraph',
  versions: ['>=1.0.15'],
  filePattern: 'dist/pregel/index.*'
}, exports => {
  const Pregel = exports.Pregel

  if (Pregel && Pregel.prototype && Pregel.prototype.stream) {
    shimmer.wrap(Pregel.prototype, 'stream', wrapStream)
  }

  return exports
})
