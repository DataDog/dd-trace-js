'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks, channel } = require('./helpers/instrument')

// Orchestrion hooks for invoke method (handles non-streaming calls)
for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, exports => exports)
}

// Shimmer-based instrumentation for stream method
// NOTE: The stream method cannot be instrumented via orchestrion because:
// 1. It contains a `super.stream()` call which breaks AST rewriting
// 2. The _streamIterator method is an async generator which also breaks AST rewriting
const startCh = channel('apm:langchain-langgraph:stream:start')
const finishCh = channel('apm:langchain-langgraph:stream:finish')
const errorCh = channel('apm:langchain-langgraph:stream:error')

addHook({ name: '@langchain/langgraph', versions: ['>=1.0.15'], file: 'dist/pregel/index.cjs' }, (moduleExports) => {
  const Pregel = moduleExports.Pregel

  if (!Pregel || !Pregel.prototype) return moduleExports

  shimmer.wrap(Pregel.prototype, 'stream', stream => function (input, options) {
    if (!startCh.hasSubscribers) return stream.apply(this, arguments)

    const ctx = {
      arguments: [input, options],
      self: this,
      moduleVersion: '1.0.15'
    }

    return startCh.runStores(ctx, async () => {
      try {
        const result = await stream.apply(this, arguments)
        ctx.result = result
        finishCh.publish(ctx)
        return result
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)
        finishCh.publish(ctx)
        throw error
      }
    })
  })

  return moduleExports
})

addHook({ name: '@langchain/langgraph', versions: ['>=1.0.15'], file: 'dist/pregel/index.js' }, (moduleExports) => {
  const Pregel = moduleExports.Pregel

  if (!Pregel || !Pregel.prototype) return moduleExports

  shimmer.wrap(Pregel.prototype, 'stream', stream => function (input, options) {
    if (!startCh.hasSubscribers) return stream.apply(this, arguments)

    const ctx = {
      arguments: [input, options],
      self: this,
      moduleVersion: '1.0.15'
    }

    return startCh.runStores(ctx, async () => {
      try {
        const result = await stream.apply(this, arguments)
        ctx.result = result
        finishCh.publish(ctx)
        return result
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)
        finishCh.publish(ctx)
        throw error
      }
    })
  })

  return moduleExports
})
