'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks, tracingChannel } = require('./helpers/instrument')

// Tracing channel for Pregel.stream() - using shimmer because the method
// uses `super.stream()` which cannot be wrapped by the orchestrion rewriter
// (the `super` keyword loses its lexical scope when wrapped in an IIFE).
const streamCh = tracingChannel('orchestrion:@langchain/langgraph:Pregel_stream')

for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, (exports) => {
    const { Pregel } = exports

    if (Pregel?.prototype?.stream) {
      shimmer.wrap(Pregel.prototype, 'stream', original => function (...args) {
        if (!streamCh.start.hasSubscribers) {
          return original.apply(this, args)
        }

        const ctx = {
          arguments: args,
          self: this
        }

        return streamCh.tracePromise(
          () => original.apply(this, args),
          ctx,
          this,
          ...args
        )
      })
    }

    return exports
  })
}
