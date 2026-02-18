'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langgraph.invoke', {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'langgraph',
      'span.kind': 'internal',
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }
}

class PregelStreamPlugin extends TracingPlugin {
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    this.startSpan('langgraph.stream', {
      service: this.config.service,
      kind: 'internal',
      component: 'langgraph',
    }, ctx)

    return ctx.currentStore
  }

  asyncStart (ctx) {
    const span = ctx.currentStore?.span
    if (!span) {
      return
    }

    const asyncIterable = ctx.result

    const originalAsyncIterator = asyncIterable[Symbol.asyncIterator].bind(asyncIterable)

    asyncIterable[Symbol.asyncIterator] = function () {
      const originalIterator = originalAsyncIterator()

      return {
        async next (...args) {
          try {
            const result = await originalIterator.next(...args)

            if (result.done) span.finish()

            return result
          } catch (error) {
            span.setTag('error', error)
            span.finish()
            throw error
          }
        },

        async return (...args) {
          span.finish()

          if (originalIterator.return) {
            return await originalIterator.return(...args)
          }
          return { done: true, value: undefined }
        },

        async throw (error) {
          span.setTag('error', error)
          span.finish()

          if (originalIterator.throw) {
            return await originalIterator.throw(error)
          }
          throw error
        },
      }
    }
  }
}

module.exports = {
  BaseLanggraphInternalPlugin,
  PregelStreamPlugin,
}
