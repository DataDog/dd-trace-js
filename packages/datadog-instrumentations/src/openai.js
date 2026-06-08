'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const ch = dc.tracingChannel('apm:openai:request')
const onStreamedChunkCh = dc.channel('apm:openai:request:chunk')
const chatCompletionsBeforeChannel = dc.channel('dd-trace:openai:chat.completions:before')
const chatCompletionsAfterChannel = dc.channel('dd-trace:openai:chat.completions:after')
const responsesBeforeChannel = dc.channel('dd-trace:openai:responses:before')
const responsesAfterChannel = dc.channel('dd-trace:openai:responses:after')

const LIFECYCLE_CHANNELS = {
  'chat.completions': {
    before: chatCompletionsBeforeChannel,
    after: chatCompletionsAfterChannel,
  },
  responses: {
    before: responsesBeforeChannel,
    after: responsesAfterChannel,
  },
}

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true,
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
    methods: ['create'],
    streamedResponse: true,
    versions: ['>=4.87.0'],
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
 * Publishes a provider-native lifecycle payload to a cancelable lifecycle channel.
 *
 * Subscribers push async work into `pending` synchronously during publication and
 * abort `abortController` with an error before the pushed promise resolves to block.
 *
 * @param {object} lifecycleChannel
 * @param {object} payload
 * @returns {Promise<void>}
 */
function publishLifecycle (lifecycleChannel, payload) {
  const abortController = new AbortController()
  const ctx = { ...payload, abortController, pending: [] }

  lifecycleChannel.publish(ctx)

  return Promise.all(ctx.pending).then(() => {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason
    }
  })
}

/**
 * Builds a lifecycle handle for OpenAI SDK promise rewiring.
 *
 * @param {string} baseResource
 * @param {Array<object>} args
 * @param {boolean} stream
 * @returns {{afterChannel: object, args: Array<object>, getBeforeVerdict: Function}|null}
 */
function createLifecycleHandle (baseResource, args, stream) {
  if (stream) return null

  const channels = LIFECYCLE_CHANNELS[baseResource]
  if (!channels || (!channels.before.hasSubscribers && !channels.after.hasSubscribers)) return null

  let beforeVerdictPromise
  const getBeforeVerdict = () => {
    beforeVerdictPromise ??= channels.before.hasSubscribers
      ? publishLifecycle(channels.before, { args })
      : Promise.resolve()
    return beforeVerdictPromise
  }

  return { afterChannel: channels.after, args, getBeforeVerdict }
}

/**
 * Wraps `apiProm.asResponse` so raw-response callers still receive the before verdict.
 *
 * @param {object} apiProm - APIPromise returned from the OpenAI SDK method
 * @param {object} lifecycle
 */
function wrapAsResponse (apiProm, lifecycle) {
  if (typeof apiProm.asResponse !== 'function') return
  shimmer.wrap(apiProm, 'asResponse', origAsResponse => function (...args) {
    const responsePromise = origAsResponse.apply(this, args)
    return Promise.all([lifecycle.getBeforeVerdict(), responsePromise]).then(([, response]) => response)
  })
}

/**
 * Gates the parsed-body promise on the before lifecycle verdict.
 *
 * @param {Promise<unknown>} parsedPromise
 * @param {object} lifecycle
 * @returns {Promise<unknown>}
 */
function gateParse (parsedPromise, lifecycle) {
  return Promise.all([lifecycle.getBeforeVerdict(), parsedPromise]).then(([, result]) => result)
}

/**
 * Runs after lifecycle subscribers against the parsed response body.
 *
 * @param {object} lifecycle
 * @param {object} body - Parsed OpenAI response body
 * @returns {Promise<void>}
 */
function evaluateOutput (lifecycle, body) {
  if (!lifecycle.afterChannel.hasSubscribers) return Promise.resolve()
  return publishLifecycle(lifecycle.afterChannel, { args: lifecycle.args, body })
}

/**
 * For streamed responses, we need to accumulate all of the content in
 * the chunks, and let the combined content be the final response.
 * This way, spans look the same as when not streamed.
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
  for (const shim of V4_PACKAGE_SHIMS) {
    const { file, targetClass, baseResource, methods, versions, streamedResponse } = shim
    addHook({ name: 'openai', file: file + extension, versions: versions || ['>=4'] }, exports => {
      const targetPrototype = exports[targetClass].prototype

      for (const methodName of methods) {
        shimmer.wrap(targetPrototype, methodName, methodFn => function (...args) {
          // The OpenAI library lets you set `stream: true` on the options arg to any method
          // However, we only want to handle streamed responses in specific cases
          // chat.completions and completions
          const stream = streamedResponse && getOption(args, 'stream', false)

          const lifecycle = createLifecycleHandle(baseResource, args, stream)

          if (!ch.start.hasSubscribers && !lifecycle) {
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

            if (baseResource === 'chat.completions' && typeof apiProm._thenUnwrap === 'function') {
              // this should only ever be invoked from a client.beta.chat.completions.parse call
              shimmer.wrap(apiProm, '_thenUnwrap', origApiPromThenUnwrap => function (...args) {
                // TODO(sam.brenner): I wonder if we can patch the APIPromise prototype instead, although
                // we might not have access to everything we need...

                // this is a new apipromise instance
                const unwrappedPromise = origApiPromThenUnwrap.apply(this, args)

                shimmer.wrap(unwrappedPromise, 'parse', origApiPromParse => function (...args) {
                  const parsedPromise = origApiPromParse.apply(this, args)
                    .then(body => Promise.all([this.responsePromise, body]))

                  return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, lifecycle)
                })

                return unwrappedPromise
              })
            }

            // wrapping `parse` avoids problematic wrapping of `then` when trying to call
            // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
            shimmer.wrap(apiProm, 'parse', origApiPromParse => function (...args) {
              const parsedPromise = origApiPromParse.apply(this, args)
                .then(body => Promise.all([this.responsePromise, body]))

              return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, lifecycle)
            })

            if (lifecycle) wrapAsResponse(apiProm, lifecycle)

            ch.end.publish(ctx)

            return apiProm
          })
        })
      }
      return exports
    })
  }
}

function handleUnwrappedAPIPromise (apiProm, ctx, stream, lifecycle) {
  const guardedApiProm = lifecycle ? gateParse(apiProm, lifecycle) : apiProm

  return guardedApiProm
    .then(([{ response, options }, body]) => {
      if (stream) {
        if (body.iterator) {
          shimmer.wrap(body, 'iterator', wrapStreamIterator(response, options, ctx))
        } else {
          shimmer.wrap(
            body.response.body, Symbol.asyncIterator, wrapStreamIterator(response, options, ctx)
          )
        }
        return body
      }

      finish(ctx, {
        headers: response.headers,
        data: body,
        request: {
          path: response.url,
          method: options.method,
        },
      })

      if (!lifecycle) return body

      return evaluateOutput(lifecycle, body).then(() => body)
    })
    .catch(error => {
      // ctx.result is set inside finish(); if absent, finish never ran (sync throw in
      // success branch, before-model block, or openai error) — record the error now.
      // If finish already ran successfully (after-model block), don't double-publish.
      if (!ctx.result) finish(ctx, undefined, error)
      throw error
    })
}

function finish (ctx, response, error) {
  if (error) {
    ctx.error = error
    ch.error.publish(ctx)
  }

  // for successful streamed responses, we've already set the result on ctx.body,
  // so we don't want to override it here
  ctx.result ??= {}
  Object.assign(ctx.result, response)

  ch.asyncEnd.publish(ctx)
}

function getOption (args, option, defaultValue) {
  return args[0]?.[option] || defaultValue
}
