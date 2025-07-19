'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const dc = require('dc-polyfill')
const ch = dc.tracingChannel('apm:openai:request')
const onStreamedChunkCh = dc.channel('apm:openai:request:chunk')

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true
  },
  {
    file: 'resources/completions',
    targetClass: 'Completions',
    baseResource: 'completions',
    methods: ['create'],
    streamedResponse: true
  },
  {
    file: 'resources/embeddings',
    targetClass: 'Embeddings',
    baseResource: 'embeddings',
    methods: ['create']
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
    versions: ['>=4.0.0 <5.0.0']
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['delete'],
    versions: ['>=5']
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['retrieveContent'],
    versions: ['>=4.0.0 <4.17.1']
  },
  {
    file: 'resources/files',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['content'], // replaced `retrieveContent` in v4.17.1
    versions: ['>=4.17.1']
  },
  {
    file: 'resources/images',
    targetClass: 'Images',
    baseResource: 'images',
    methods: ['createVariation', 'edit', 'generate']
  },
  {
    file: 'resources/fine-tuning/jobs/jobs',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.34.0'] // file location changed in 4.34.0
  },
  {
    file: 'resources/fine-tuning/jobs',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.1.0 <4.34.0']
  },
  {
    file: 'resources/fine-tunes', // deprecated after 4.1.0
    targetClass: 'FineTunes',
    baseResource: 'fine-tune',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.0.0 <4.1.0']
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['list', 'retrieve']
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['del'],
    versions: ['>=4 <5']
  },
  {
    file: 'resources/models',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['delete'],
    versions: ['>=5']
  },
  {
    file: 'resources/moderations',
    targetClass: 'Moderations',
    baseResource: 'moderations',
    methods: ['create']
  },
  {
    file: 'resources/audio/transcriptions',
    targetClass: 'Transcriptions',
    baseResource: 'audio.transcriptions',
    methods: ['create']
  },
  {
    file: 'resources/audio/translations',
    targetClass: 'Translations',
    baseResource: 'audio.translations',
    methods: ['create']
  },
  {
    file: 'resources/chat/completions/completions',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true,
    versions: ['>=4.85.0']
  }
]

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0 <4'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function () {
      if (!ch.start.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      const ctx = {
        methodName,
        args: arguments,
        basePath: this.basePath,
        apiKey: this.configuration.apiKey
      }

      return ch.tracePromise(fn, ctx, this, ...arguments)
    })
  }

  return exports
})

/**
 * For streamed responses, we need to accumulate all of the content in
 * the chunks, and let the combined content be the final response.
 * This way, spans look the same as when not streamed.
 */
function wrapStreamIterator (response, options, ctx) {
  return function (itr) {
    return function () {
      const iterator = itr.apply(this, arguments)
      shimmer.wrap(iterator, 'next', next => function () {
        return next.apply(this, arguments)
          .then(res => {
            const { done, value: chunk } = res
            onStreamedChunkCh.publish({ ctx, chunk, done })

            if (done) {
              finish(ctx, {
                headers: response.headers,
                request: {
                  path: response.url,
                  method: options.method
                }
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
        shimmer.wrap(targetPrototype, methodName, methodFn => function () {
          if (!ch.start.hasSubscribers) {
            return methodFn.apply(this, arguments)
          }

          // The OpenAI library lets you set `stream: true` on the options arg to any method
          // However, we only want to handle streamed responses in specific cases
          // chat.completions and completions
          const stream = streamedResponse && getOption(arguments, 'stream', false)

          const client = this._client || this.client

          const ctx = {
            methodName: `${baseResource}.${methodName}`,
            args: arguments,
            basePath: client.baseURL,
            apiKey: client.apiKey
          }

          return ch.start.runStores(ctx, () => {
            const apiProm = methodFn.apply(this, arguments)

            if (baseResource === 'chat.completions' && typeof apiProm._thenUnwrap === 'function') {
              // this should only ever be invoked from a client.beta.chat.completions.parse call
              shimmer.wrap(apiProm, '_thenUnwrap', origApiPromThenUnwrap => function () {
                // TODO(sam.brenner): I wonder if we can patch the APIPromise prototype instead, although
                // we might not have access to everything we need...

                // this is a new apipromise instance
                const unwrappedPromise = origApiPromThenUnwrap.apply(this, arguments)

                shimmer.wrap(unwrappedPromise, 'parse', origApiPromParse => function () {
                  const parsedPromise = origApiPromParse.apply(this, arguments)
                    .then(body => Promise.all([this.responsePromise, body]))

                  return handleUnwrappedAPIPromise(parsedPromise, ctx, stream)
                })

                return unwrappedPromise
              })
            }

            // wrapping `parse` avoids problematic wrapping of `then` when trying to call
            // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
            shimmer.wrap(apiProm, 'parse', origApiPromParse => function () {
              const parsedPromise = origApiPromParse.apply(this, arguments)
                .then(body => Promise.all([this.responsePromise, body]))

              return handleUnwrappedAPIPromise(parsedPromise, ctx, stream)
            })

            ch.end.publish(ctx)

            return apiProm
          })
        })
      }
      return exports
    })
  }
}

function handleUnwrappedAPIPromise (apiProm, ctx, stream) {
  return apiProm
    .then(([{ response, options }, body]) => {
      if (stream) {
        if (body.iterator) {
          shimmer.wrap(body, 'iterator', wrapStreamIterator(response, options, ctx))
        } else {
          shimmer.wrap(
            body.response.body, Symbol.asyncIterator, wrapStreamIterator(response, options, ctx)
          )
        }
      } else {
        finish(ctx, {
          headers: response.headers,
          data: body,
          request: {
            path: response.url,
            method: options.method
          }
        })
      }

      return body
    })
    .catch(error => {
      finish(ctx, undefined, error)

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
