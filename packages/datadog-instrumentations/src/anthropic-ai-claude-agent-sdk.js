'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const queryChannel = tracingChannel('apm:claude-agent-sdk:query')

/**
 * Wraps the query() async generator so that:
 * - A span starts via runStores before the generator is created
 * - asyncEnd is published when the generator is exhausted or throws
 *
 * @param {Function} query - original query export
 * @returns {Function} wrapped query
 */
function wrapQuery (query) {
  return function wrappedQuery (...args) {
    if (!queryChannel.start.hasSubscribers) {
      return query.apply(this, args)
    }

    const params = args[0]
    const ctx = { params }

    return queryChannel.start.runStores(ctx, () => {
      let gen
      try {
        gen = query.apply(this, args)
      } catch (err) {
        ctx.error = err
        queryChannel.error.publish(ctx)
        queryChannel.asyncEnd.publish(ctx)
        throw err
      }

      queryChannel.end.publish(ctx)

      // Wrap the async generator so we can detect exhaustion / errors
      const origNext = gen.next.bind(gen)
      const origReturn = gen.return ? gen.return.bind(gen) : undefined
      const origThrow = gen.throw ? gen.throw.bind(gen) : undefined

      function finish (err) {
        if (err) {
          ctx.error = err
          queryChannel.error.publish(ctx)
        }
        queryChannel.asyncEnd.publish(ctx)
      }

      gen.next = function (...nextArgs) {
        return origNext(...nextArgs).then(
          result => {
            if (result.done) finish()
            return result
          },
          err => {
            finish(err)
            throw err
          }
        )
      }

      if (origReturn) {
        gen.return = function (...retArgs) {
          return origReturn(...retArgs).then(
            result => {
              if (result.done) finish()
              return result
            },
            err => {
              finish(err)
              throw err
            }
          )
        }
      }

      if (origThrow) {
        gen.throw = function (...throwArgs) {
          return origThrow(...throwArgs).then(
            result => {
              if (result.done) finish()
              return result
            },
            err => {
              finish(err)
              throw err
            }
          )
        }
      }

      return gen
    })
  }
}

addHook({
  name: '@anthropic-ai/claude-agent-sdk',
  versions: ['>=0.1.0'],
}, exports => {
  return shimmer.wrap(exports, 'query', wrapQuery)
})
