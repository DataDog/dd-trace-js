'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const anthropicTracingChannel = tracingChannel('apm:anthropic:request')
const onStreamedChunkCh = channel('apm:anthropic:request:chunk')

// `prepare` is published before the SDK is invoked, so subscribers may replace `arguments[0]`.
// `intercept` follows with the native call data; a subscriber may set either callback and this
// instrumentation applies it, so the wrapping stays here and only the policy lives outside:
//   beforeResult () => Promise<void>|undefined   holds the result back until it settles
//   onResult (body) => unknown|Promise<unknown>  inspects or replaces the delivered body
const messagesPrepareChannel = channel('dd-trace:anthropic:messages:prepare')
const messagesInterceptChannel = channel('dd-trace:anthropic:messages:intercept')

/**
 * Returns `promise`, but not before `settled` settles, so a rejection from an interceptor
 * reaches the caller instead of the SDK's value.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {Promise<void>|undefined} settled
 * @returns {Promise<T>}
 */
function heldUntil (promise, settled) {
  if (!settled) return promise

  // The interceptor's rejection wins over an earlier SDK rejection, so keep that one handled.
  promise.catch(() => {})
  return settled.then(() => promise)
}

/**
 * @param {object} ctx
 * @param {Error} error
 * @throws {Error} Always rethrows the supplied error.
 */
function finishAndThrow (ctx, error) {
  finish(ctx, null, error)
  throw error
}

/**
 * @param {object} response
 * @param {'json'|'text'} method
 * @param {object} ctx
 * @param {object} [interceptCtx]
 */
function wrapResponseReader (response, method, ctx, interceptCtx) {
  if (typeof response[method] !== 'function') return

  shimmer.wrap(response, method, original => function (...args) {
    return original.apply(this, args)
      .then(body => {
        // `text()` callers keep their string; only the callback and the span see the parsed body.
        let parsed = body
        if (method === 'text') {
          try {
            parsed = JSON.parse(body)
          } catch {
            finish(ctx)
            return body
          }
        }

        if (!interceptCtx?.onResult) {
          finish(ctx, parsed)
          return body
        }

        return Promise.resolve(interceptCtx.onResult(parsed)).then(deliveredBody => {
          finish(ctx, parsed)
          // `json()` callers get any replacement; `text()` callers keep their original string,
          // because the callback was handed the parsed object rather than the text.
          return method === 'json' ? deliveredBody : body
        })
      })
      .catch(error => finishAndThrow(ctx, error))
  })
}

/**
 * @param {object} response
 * @param {object} ctx
 * @param {object} [interceptCtx]
 */
function wrapRawResponse (response, ctx, interceptCtx) {
  wrapResponseReader(response, 'json', ctx, interceptCtx)
  wrapResponseReader(response, 'text', ctx, interceptCtx)

  if (typeof response.clone !== 'function') return

  shimmer.wrap(response, 'clone', clone => function (...args) {
    const clonedResponse = clone.apply(this, args)
    wrapRawResponse(clonedResponse, ctx, interceptCtx)
    return clonedResponse
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
    const stream = args[0]?.stream
    const preparing = !stream && messagesPrepareChannel.hasSubscribers
    const intercepting = !stream && messagesInterceptChannel.hasSubscribers

    if (!anthropicTracingChannel.start.hasSubscribers && !preparing && !intercepting) {
      return create.apply(this, args)
    }

    // `args` is this wrapper's own rest array, so replacing `arguments[0]` changes what reaches
    // the SDK without touching anything the caller still holds.
    if (preparing) {
      messagesPrepareChannel.publish({ arguments: args })
    }

    const ctx = { options: args[0], resource: 'create', baseUrl: this._client?.baseURL }

    return anthropicTracingChannel.start.runStores(ctx, () => {
      let apiPromise
      try {
        // Anthropic starts the request eagerly, so subscribers can only hold back delivery.
        apiPromise = create.apply(this, args)
      } catch (error) {
        finish(ctx, null, error)
        throw error
      }

      let interceptCtx
      if (intercepting) {
        interceptCtx = { arguments: args, tracingContext: ctx }
        messagesInterceptChannel.publish(interceptCtx)
      }

      let parseResult
      let wrappedResponse

      shimmer.wrap(apiPromise, 'parse', parse => function (...parseArgs) {
        if (parseResult) return parseResult

        parseResult = heldUntil(parse.apply(this, parseArgs), interceptCtx?.beforeResult?.())
          .then(response => {
            if (stream) {
              shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
              return response
            }

            if (!interceptCtx?.onResult) {
              finish(ctx, response)
              return response
            }

            return Promise.resolve(interceptCtx.onResult(response)).then(deliveredResponse => {
              finish(ctx, response)
              return deliveredResponse
            })
          })
          .catch(error => finishAndThrow(ctx, error))

        return parseResult
      })

      if (typeof apiPromise.asResponse === 'function') {
        shimmer.wrap(apiPromise, 'asResponse', origAsResponse => function (...asResponseArgs) {
          return heldUntil(origAsResponse.apply(this, asResponseArgs), interceptCtx?.beforeResult?.())
            .then(response => {
              // Wrap json()/text()/clone() so the span still closes on the raw-response path,
              // and not twice for the same response.
              if (!stream && wrappedResponse !== response) {
                wrappedResponse = response
                wrapRawResponse(response, ctx, interceptCtx)
              }
              return response
            })
            .catch(error => finishAndThrow(ctx, error))
        })
      }

      anthropicTracingChannel.end.publish(ctx)

      return apiPromise
    })
  }
}

function finish (ctx, result, error) {
  if (ctx.finished) return

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
