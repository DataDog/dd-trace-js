'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const anthropicTracingChannel = tracingChannel('apm:anthropic:request')
const onStreamedChunkCh = channel('apm:anthropic:request:chunk')
const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

/**
 * Publishes a provider-native lifecycle payload to a cancelable lifecycle channel.
 *
 * Subscribers push async work into `pending` synchronously during publication and
 * abort `abortController` with an error before the pushed promise resolves to block.
 *
 * @param {object} channel
 * @param {object} payload
 * @returns {Promise<void>}
 */
function publishLifecycle (channel, payload) {
  const abortController = new AbortController()
  const ctx = { ...payload, abortController, pending: [] }

  channel.publish(ctx)

  return Promise.all(ctx.pending).then(() => {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason
    }
  })
}

function wrapStreamIterator (iterator, ctx) {
  return function (...args) {
    const itr = iterator.apply(this, args)
    shimmer.wrap(itr, 'next', next => function (...args) {
      return next.apply(this, args)
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
  return function (...args) {
    const options = args[0]
    const stream = options?.stream

    const hasLifecycle = !stream && (messagesBeforeChannel.hasSubscribers || messagesAfterChannel.hasSubscribers)

    if (!anthropicTracingChannel.start.hasSubscribers && !hasLifecycle) {
      return create.apply(this, args)
    }

    const ctx = { options, resource: 'create', baseUrl: this._client?.baseURL }

    return anthropicTracingChannel.start.runStores(ctx, () => {
      const parentSpan = hasLifecycle ? ctx.currentStore?.span : undefined

      let apiPromise
      try {
        apiPromise = create.apply(this, args)
      } catch (error) {
        finish(ctx, null, error)
        throw error
      }

      let beforeVerdict

      function getBeforeVerdict () {
        if (!hasLifecycle || !messagesBeforeChannel.hasSubscribers) return

        beforeVerdict ??= publishLifecycle(messagesBeforeChannel, { args, parentSpan })
        return beforeVerdict
      }

      shimmer.wrap(apiPromise, 'parse', parse => function (...parseArgs) {
        const parsed = parse.apply(this, parseArgs)
        const verdict = getBeforeVerdict()
        const parsedAfterBeforeVerdict = verdict
          ? Promise.all([verdict, parsed]).then(([, response]) => response)
          : parsed

        return parsedAfterBeforeVerdict
          .then(response => {
            if (stream) {
              shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
              return response
            }
            if (!hasLifecycle || !messagesAfterChannel.hasSubscribers) {
              finish(ctx, response, null)
              return response
            }
            // Finish after evaluation so a block propagates the error to anthropic.request
            // and the span wraps its child instead of closing before it.
            return publishLifecycle(messagesAfterChannel, { args, body: response, parentSpan }).then(() => {
              finish(ctx, response, null)
              return response
            })
          }).catch(error => {
            if (!ctx.finished) finish(ctx, null, error)
            throw error
          })
      })

      // Gate `.asResponse()` callers on the before verdict so raw-response paths still block.
      shimmer.wrap(apiPromise, 'asResponse', origAsResponse => function (...asResponseArgs) {
        const responsePromise = origAsResponse.apply(this, asResponseArgs)
        const verdict = getBeforeVerdict()
        return verdict
          ? Promise.all([verdict, responsePromise]).then(([, response]) => response)
          : responsePromise
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
  ctx.finished = true

  anthropicTracingChannel.asyncEnd.publish(ctx)
}

const extensions = ['js', 'mjs']
for (const extension of extensions) {
  addHook({
    name: '@anthropic-ai/sdk',
    file: `resources/messages.${extension}`,
    versions: ['>=0.14.0 <0.33.0'],
  }, exports => {
    const Messages = exports.Messages

    shimmer.wrap(Messages.prototype, 'create', wrapCreate)

    return exports
  })

  addHook({
    name: '@anthropic-ai/sdk',
    file: `resources/messages/messages.${extension}`,
    versions: ['>=0.33.0'],
  }, exports => {
    const Messages = exports.Messages

    shimmer.wrap(Messages.prototype, 'create', wrapCreate)

    return exports
  })

  addHook({
    name: '@anthropic-ai/sdk',
    file: `resources/beta/messages/messages.${extension}`,
    versions: ['>=0.33.0'],
  }, exports => {
    const Messages = exports.Messages

    shimmer.wrap(Messages.prototype, 'create', wrapCreate)

    return exports
  })
}
