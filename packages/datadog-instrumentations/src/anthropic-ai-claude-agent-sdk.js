'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// Orchestrion cannot intercept the dynamically-iterated AsyncGenerator returned
// by `query()`/`WarmQuery.query()` — we need to wrap `next()` / `return()` on
// the generator instance at runtime, plus pivot the WarmQuery returned by
// `startup()`. Shimmer is required for this factory + per-instance pattern.
const claudeAgentSdkChannel = tracingChannel('apm:anthropic-ai-claude-agent-sdk:query')
const onMessageCh = require('dc-polyfill').channel('apm:anthropic-ai-claude-agent-sdk:message')

function finish (ctx, error) {
  if (ctx.finished) return
  ctx.finished = true

  if (error) {
    ctx.error = error
    claudeAgentSdkChannel.error.publish(ctx)
  }

  claudeAgentSdkChannel.asyncEnd.publish(ctx)
}

function wrapGenerator (generator, ctx) {
  shimmer.wrap(generator, 'next', next => function (...args) {
    return next.apply(this, args)
      .then(res => {
        const { done, value: message } = res

        if (message && typeof message === 'object') {
          onMessageCh.publish({ ctx, message })

          if (message.type === 'result') {
            ctx.result = message
            finish(ctx)
          }
        }

        if (done) {
          finish(ctx)
        }

        return res
      })
      .catch(error => {
        finish(ctx, error)
        throw error
      })
  })

  if (typeof generator.return === 'function') {
    shimmer.wrap(generator, 'return', ret => function (...args) {
      const result = ret.apply(this, args)
      finish(ctx)
      return result
    })
  }

  if (typeof generator.throw === 'function') {
    shimmer.wrap(generator, 'throw', thr => function (...args) {
      finish(ctx, args[0])
      return thr.apply(this, args)
    })
  }

  return generator
}

function wrapQuery (query) {
  return function (...args) {
    if (!claudeAgentSdkChannel.start.hasSubscribers) {
      return query.apply(this, args)
    }

    const params = args[0] || {}
    const options = params.options || {}

    const ctx = {
      resource: 'query',
      options,
      params,
    }

    return claudeAgentSdkChannel.start.runStores(ctx, () => {
      let generator
      try {
        generator = query.apply(this, args)
      } catch (error) {
        finish(ctx, error)
        throw error
      }

      claudeAgentSdkChannel.end.publish(ctx)

      return wrapGenerator(generator, ctx)
    })
  }
}

function wrapWarmQueryQuery (originalQuery) {
  return function (...args) {
    if (!claudeAgentSdkChannel.start.hasSubscribers) {
      return originalQuery.apply(this, args)
    }

    const ctx = {
      resource: 'WarmQuery.query',
      options: this?._options || {},
      params: { prompt: args[0] },
    }

    return claudeAgentSdkChannel.start.runStores(ctx, () => {
      let generator
      try {
        generator = originalQuery.apply(this, args)
      } catch (error) {
        finish(ctx, error)
        throw error
      }

      claudeAgentSdkChannel.end.publish(ctx)

      return wrapGenerator(generator, ctx)
    })
  }
}

function wrapStartup (startup) {
  return function (...args) {
    const promise = startup.apply(this, args)

    if (!promise || typeof promise.then !== 'function') return promise

    return promise.then(warmQuery => {
      if (warmQuery && typeof warmQuery.query === 'function') {
        shimmer.wrap(warmQuery, 'query', wrapWarmQueryQuery)
      }
      return warmQuery
    })
  }
}

addHook({
  name: '@anthropic-ai/claude-agent-sdk',
  versions: ['>=0.1.0'],
}, exports => {
  if (typeof exports.query === 'function') {
    shimmer.wrap(exports, 'query', wrapQuery)
  }
  if (typeof exports.startup === 'function') {
    shimmer.wrap(exports, 'startup', wrapStartup)
  }
  return exports
})
