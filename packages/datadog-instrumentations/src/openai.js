'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const ch = dc.tracingChannel('apm:openai:request')
const onStreamedChunkCh = dc.channel('apm:openai:request:chunk')
const responsePromiseContexts = new WeakMap()

// Published synchronously with the native call data. A subscriber may set either callback and
// this instrumentation applies it, so the wrapping stays here and only the policy lives outside:
//   beforeResult () => Promise<void>|undefined   holds the result back until it settles
//   onResult (body) => unknown|Promise<unknown>  inspects or replaces the delivered body
const chatCompletionsInterceptChannel = dc.channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = dc.channel('dd-trace:openai:responses:intercept')

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

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true,
    interceptChannel: chatCompletionsInterceptChannel,
  },
  {
    file: 'resources/completions',
    targetClass: 'Completions',
    baseResource: 'completions',
    methods: ['create'],
    streamedResponse: true,
  },
  {
    file: 'resources/responses/responses',
    targetClass: 'Responses',
    baseResource: 'responses',
    methods: ['create'], // implicitly covers `parse` as well which calls `create` under the hood
    streamedResponse: true,
    versions: ['>=4.87.0'],
    interceptChannel: responsesInterceptChannel,
  },
  {
    file: 'resources/embeddings',
    targetClass: 'Embeddings',
    baseResource: 'embeddings',
    methods: ['create'],
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['create', 'list', 'retrieve'],
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['del'],
    versions: ['>=4.0.0 <5.0.0'],
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['delete'],
    versions: ['>=5'],
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['retrieveContent'],
    versions: ['>=4.0.0 <4.17.1'],
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['content'], // replaced `retrieveContent` in v4.17.1
    versions: ['>=4.17.1'],
  },
  {
    file: 'resources/images',
    targetClass: 'Images',
    baseResource: 'images',
    methods: ['createVariation', 'edit', 'generate'],
  },
  {
    file: 'resources/fine-tuning/jobs/jobs',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.34.0'], // file location changed in 4.34.0
  },
  {
    file: 'resources/fine-tuning/jobs',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.1.0 <4.34.0'],
  },
  {
    file: 'resources/fine-tunes', // deprecated after 4.1.0
    targetClass: 'FineTunes',
    baseResource: 'fine-tune',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.0.0 <4.1.0'],
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['list', 'retrieve'],
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['del'],
    versions: ['>=4 <5'],
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['delete'],
    versions: ['>=5'],
  },
  {
    file: 'resources/moderations',
    targetClass: 'Moderations',
    baseResource: 'moderations',
    methods: ['create'],
  },
  {
    file: 'resources/audio/transcriptions',
    targetClass: 'Transcriptions',
    baseResource: 'audio.transcriptions',
    methods: ['create'],
  },
  {
    file: 'resources/audio/translations',
    targetClass: 'Translations',
    baseResource: 'audio.translations',
    methods: ['create'],
  },
  {
    file: 'resources/chat/completions/completions',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true,
    versions: ['>=4.85.0'],
    interceptChannel: chatCompletionsInterceptChannel,
  },
]

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0 <4'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function (...args) {
      if (!ch.start.hasSubscribers) {
        return fn.apply(this, args)
      }

      const ctx = {
        methodName,
        args,
        basePath: this.basePath,
      }

      return ch.tracePromise(fn, ctx, this, ...args)
    })
  }

  return exports
})

/**
 * @typedef {{
 *   methodName: string,
 *   args: unknown[],
 *   basePath?: string,
 *   result?: Record<string, unknown>,
 *   error?: unknown,
 * }} OpenAiContext
 */

/**
 * For streamed responses, we need to accumulate all of the content in
 * the chunks, and let the combined content be the final response.
 * This way, spans look the same as when not streamed.
 *
 * @param {{ headers: unknown, url: string }} response
 * @param {{ method: string }} options
 * @param {OpenAiContext} ctx
 */
function wrapStreamIterator (response, options, ctx) {
  return function (itr) {
    return function (...args) {
      const iterator = itr.apply(this, args)
      shimmer.wrap(iterator, 'next', next => function (...args) {
        return next.apply(this, args)
          .then(res => {
            const { done, value: chunk } = res
            onStreamedChunkCh.publish({ ctx, chunk, done })

            if (done) {
              finish(ctx, {
                headers: response.headers,
                request: {
                  path: response.url,
                  method: options.method,
                },
              })
            }

            return res
          })
          .catch(err => {
            finish(ctx, undefined, err)

            throw err
          })
      })
      return iterator
    }
  }
}

const extensions = ['.js', '.mjs']

for (const extension of extensions) {
  const apiPromiseShims = [
    { file: `core${extension}`, versions: ['>=4 <5'] },
    { file: `core/api-promise${extension}`, versions: ['>=5'] },
  ]

  for (const { file, versions } of apiPromiseShims) {
    // APIPromise is a Promise subclass whose methods are dynamically replaced on pagination instances,
    // so preserving the returned object's identity requires shimmer instead of Orchestrion.
    addHook({ name: 'openai', file, versions }, exports => {
      const { prototype } = exports.APIPromise

      shimmer.wrap(prototype, 'parse', parse => function (...args) {
        const state = responsePromiseContexts.get(this.responsePromise)
        if (!state) return parse.apply(this, args)

        const parsedPromise = parse.apply(this, args)
          .then(body => Promise.all([this.responsePromise, body]))

        return handleUnwrappedAPIPromise(parsedPromise, state)
      })

      // Raw-response callers bypass `parse`, so run the interceptor here too.
      shimmer.wrap(prototype, 'asResponse', asResponse => function (...args) {
        const state = responsePromiseContexts.get(this.responsePromise)

        return heldUntil(asResponse.apply(this, args), state?.interceptCtx?.beforeResult?.())
      })

      return exports
    })
  }
}

for (const extension of extensions) {
  for (const shim of V4_PACKAGE_SHIMS) {
    const { file, targetClass, baseResource, methods, versions, streamedResponse, interceptChannel } = shim
    addHook({ name: 'openai', file: file + extension, versions: versions || ['>=4'] }, exports => {
      const targetPrototype = exports[targetClass].prototype

      for (const methodName of methods) {
        shimmer.wrap(targetPrototype, methodName, methodFn => function (...args) {
          // The OpenAI library lets you set `stream: true` on the options arg to any method
          // However, we only want to handle streamed responses in specific cases
          // chat.completions and completions
          const stream = streamedResponse && getOption(args, 'stream', false)

          const intercepted = !stream && interceptChannel?.hasSubscribers

          if (!ch.start.hasSubscribers && !intercepted) {
            return methodFn.apply(this, args)
          }

          const client = this._client || this.client

          const ctx = {
            methodName: `${baseResource}.${methodName}`,
            args,
            basePath: client.baseURL,
          }

          return ch.start.runStores(ctx, () => {
            const apiProm = methodFn.apply(this, args)

            let interceptCtx
            if (intercepted) {
              interceptCtx = { arguments: args, tracingContext: ctx }
              interceptChannel.publish(interceptCtx)
            }

            // Keyed by the response promise rather than the APIPromise: `_thenUnwrap` builds a new
            // APIPromise around the same response, which is how `responses.parse` and the
            // pagination page types reach the prototype wrappers above. A method that resolves to
            // a plain value has none, and a WeakMap rejects a non-object key.
            if (apiProm?.responsePromise) {
              responsePromiseContexts.set(apiProm.responsePromise, { ctx, stream, interceptCtx })
            }

            ch.end.publish(ctx)

            return apiProm
          })
        })
      }
      return exports
    })
  }
}

function handleUnwrappedAPIPromise (apiProm, state) {
  const { ctx, stream, interceptCtx } = state

  return heldUntil(apiProm, interceptCtx?.beforeResult?.())
    .then(([{ response, options }, body]) => {
      if (stream) {
        const wrapIterator = wrapStreamIterator(response, options, ctx)

        if (body.iterator) {
          shimmer.wrap(body, 'iterator', wrapIterator)
        } else {
          shimmer.wrap(body.response.body, Symbol.asyncIterator, wrapIterator)
        }
        return body
      }

      const responseData = {
        headers: response.headers,
        data: body,
        request: {
          path: response.url,
          method: options.method,
        },
      }

      if (!interceptCtx?.onResult) {
        finish(ctx, responseData)
        return body
      }

      // Finish after the callback settles so a rejection propagates to openai.request and the
      // span wraps its child instead of closing before it.
      return Promise.resolve(interceptCtx.onResult(body)).then(deliveredBody => {
        finish(ctx, responseData)
        return deliveredBody
      })
    })
    .catch(error => {
      finish(ctx, undefined, error)
      throw error
    })
}

function finish (ctx, response, error) {
  // `parse` is re-entered on every await of the same APIPromise, and a stream may be iterated
  // more than once, so the span must only close once.
  if (ctx.finished) return

  if (error) {
    ctx.error = error
    ch.error.publish(ctx)
  }

  // for successful streamed responses, we've already set the result on ctx.body,
  // so we don't want to override it here
  ctx.result ??= {}
  Object.assign(ctx.result, response)
  ctx.finished = true

  ch.asyncEnd.publish(ctx)
}

function getOption (args, option, defaultValue) {
  return args[0]?.[option] || defaultValue
}
