'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// Shimmer instead of orchestrion: `Chat.stream` resolves to an `EventStream` (a `ReadableStream` subclass with no
// `next` method), so the rewriter's `returnKind: 'AsyncIterator'` cannot observe chunks or finish the span when the
// stream is fully consumed. All three methods share one channel and lifecycle.
const mistralTracingChannel = tracingChannel('apm:mistralai:request')
const onStreamedChunkCh = channel('apm:mistralai:request:chunk')

/**
 * @param {object} ctx
 * @param {object} [result]
 * @param {Error} [error]
 */
function finish (ctx, result, error) {
  if (ctx.finished) return

  if (error) {
    ctx.error = error
    mistralTracingChannel.error.publish(ctx)
  }

  // streamed responses are aggregated by the chunk channel subscriber
  ctx.result ??= result
  ctx.finished = true

  mistralTracingChannel.asyncEnd.publish(ctx)
}

function wrapStreamIterator (iterator, ctx) {
  return function (...args) {
    const itr = iterator.apply(this, args)
    shimmer.wrap(itr, 'next', next => function (...args) {
      return next.apply(this, args)
        .then(res => {
          const { done, value: chunk } = res
          onStreamedChunkCh.publish({ ctx, chunk, done })

          if (done) finish(ctx)

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

/**
 * @param {string} resource `Chat.complete`, `Chat.stream` or `Embeddings.create`
 * @param {boolean} stream whether the resolved value is an `EventStream`
 */
function wrapMethod (resource, stream) {
  return function wrap (method) {
    return function (...args) {
      if (!mistralTracingChannel.start.hasSubscribers) {
        return method.apply(this, args)
      }

      const request = args[0]
      const serverURL = args[1]?.serverURL ?? this._baseURL?.href ?? ''
      const ctx = { request, resource, serverURL }

      return mistralTracingChannel.start.runStores(ctx, () => {
        let apiPromise
        try {
          apiPromise = method.apply(this, args)
        } catch (error) {
          finish(ctx, null, error)
          throw error
        }

        if (typeof apiPromise?.then !== 'function') {
          finish(ctx, apiPromise)
          return apiPromise
        }

        // The SDK returns an `APIPromise` subclass; chain from the original so callers keep it intact.
        apiPromise.then(response => {
          if (stream && response && typeof response[Symbol.asyncIterator] === 'function') {
            shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
          } else {
            finish(ctx, response)
          }
        }, error => {
          finish(ctx, null, error)
        })

        mistralTracingChannel.end.publish(ctx)

        return apiPromise
      })
    }
  }
}

const patchedPrototypes = new WeakSet()

/**
 * The SDK is ESM-only and `Chat`/`Embeddings` are not re-exported from the package root, so their prototypes are
 * patched lazily the first time a `Mistral` client exposes them.
 *
 * @param {Function} Mistral the SDK client class
 * @param {string} property `chat` or `embeddings`
 * @param {Array<[string, string, boolean]>} methods `[method, resource, stream]` tuples
 */
function wrapSdkGetter (Mistral, property, methods) {
  const descriptor = Object.getOwnPropertyDescriptor(Mistral.prototype, property)
  const getter = descriptor?.get
  if (typeof getter !== 'function') return

  Object.defineProperty(Mistral.prototype, property, {
    ...descriptor,
    get () {
      const sdk = getter.call(this)
      const proto = sdk && Object.getPrototypeOf(sdk)

      if (proto && !patchedPrototypes.has(proto)) {
        patchedPrototypes.add(proto)
        for (const [method, resource, stream] of methods) {
          if (typeof proto[method] === 'function') {
            shimmer.wrap(proto, method, wrapMethod(resource, stream))
          }
        }
      }

      return sdk
    },
  })
}

addHook({
  name: '@mistralai/mistralai',
  versions: ['>=2.0.0'],
}, exports => {
  const { Mistral } = /** @type {{ Mistral?: Function }} */ (exports)
  if (typeof Mistral === 'function') {
    wrapSdkGetter(Mistral, 'chat', [
      ['complete', 'Chat.complete', false],
      ['stream', 'Chat.stream', true],
    ])
    wrapSdkGetter(Mistral, 'embeddings', [
      ['create', 'Embeddings.create', false],
    ])
  }

  return exports
})
