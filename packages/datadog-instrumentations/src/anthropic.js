'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { channel, tracingChannel } = require('dc-polyfill')

const anthropicTracingChannel = tracingChannel('apm:anthropic:request')
const onStreamedChunkCh = channel('apm:anthropic:request:chunk')

function wrapStreamIterator (iterator, ctx) {
  return function () {
    const itr = iterator.apply(this, arguments)
    shimmer.wrap(itr, 'next', next => function () {
      return next.apply(this, arguments)
        .then(res => {
          const { done, value: chunk } = res
          onStreamedChunkCh.publish({ ctx, chunk, done })

          if (done) {
            finish(ctx)
          }

          return res
        })
        .catch(error => {
          finish(ctx, null, error)
          throw error
        })
    })

    return itr
  }
}

function wrapCreate (create) {
  return function () {
    if (!anthropicTracingChannel.start.hasSubscribers) {
      return create.apply(this, arguments)
    }

    const options = arguments[0]
    const stream = options.stream

    const ctx = { options, resource: 'create' }

    return anthropicTracingChannel.start.runStores(ctx, () => {
      let apiPromise
      try {
        apiPromise = create.apply(this, arguments)
      } catch (error) {
        finish(ctx, null, error)
        throw error
      }

      shimmer.wrap(apiPromise, 'parse', parse => function () {
        return parse.apply(this, arguments)
          .then(response => {
            if (stream) {
              shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
            } else {
              finish(ctx, response, null)
            }

            return response
          }).catch(error => {
            finish(ctx, null, error)
            throw error
          })
      })

      anthropicTracingChannel.end.publish(ctx)

      return apiPromise
    })
  }
}

function finish (ctx, result, error) {
  if (error) {
    ctx.error = error
    anthropicTracingChannel.error.publish(ctx)
  }

  // streamed responses are handled and set separately
  ctx.result ??= result

  anthropicTracingChannel.asyncEnd.publish(ctx)
}

const extensions = ['js', 'mjs']
for (const extension of extensions) {
  addHook({
    name: '@anthropic-ai/sdk',
    file: `resources/messages.${extension}`,
    versions: ['>=0.14.0 <0.33.0']
  }, exports => {
    const Messages = exports.Messages

    shimmer.wrap(Messages.prototype, 'create', wrapCreate)

    return exports
  })

  addHook({
    name: '@anthropic-ai/sdk',
    file: `resources/messages/messages.${extension}`,
    versions: ['>=0.33.0']
  }, exports => {
    const Messages = exports.Messages

    shimmer.wrap(Messages.prototype, 'create', wrapCreate)

    return exports
  })
}
