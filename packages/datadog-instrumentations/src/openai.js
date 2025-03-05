'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const dc = require('dc-polyfill')
const ch = dc.tracingChannel('apm:openai:request')

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
    methods: ['create', 'del', 'list', 'retrieve']
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
    methods: ['del', 'list', 'retrieve']
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

function addStreamedChunk (content, chunk) {
  content.usage = chunk.usage // add usage if it was specified to be returned
  for (const choice of chunk.choices) {
    const choiceIdx = choice.index
    const oldChoice = content.choices.find(choice => choice?.index === choiceIdx)
    if (!oldChoice) {
      // we don't know which choices arrive in which order
      content.choices[choiceIdx] = choice
    } else {
      if (!oldChoice.finish_reason) {
        oldChoice.finish_reason = choice.finish_reason
      }

      // delta exists on chat completions
      const delta = choice.delta

      if (delta) {
        const content = delta.content
        if (content) {
          if (oldChoice.delta.content) { // we don't want to append to undefined
            oldChoice.delta.content += content
          } else {
            oldChoice.delta.content = content
          }
        }
      } else {
        const text = choice.text
        if (text) {
          if (oldChoice.text) {
            oldChoice.text += text
          } else {
            oldChoice.text = text
          }
        }
      }

      // tools only exist on chat completions
      const tools = delta && choice.delta.tool_calls

      if (tools) {
        oldChoice.delta.tool_calls = tools.map((newTool, toolIdx) => {
          const oldTool = oldChoice.delta.tool_calls?.[toolIdx]

          if (oldTool) {
            oldTool.function.arguments += newTool.function.arguments
          } else {
            return newTool
          }

          return oldTool
        })
      }
    }
  }
}

function convertBufferstoObjects (chunks = []) {
  return Buffer
    .concat(chunks) // combine the buffers
    .toString() // stringify
    .split(/(?=data:)/) // split on "data:"
    .map(chunk => chunk.split('\n').join('')) // remove newlines
    .map(chunk => chunk.substring(6)) // remove 'data: ' from the front
    .slice(0, -1) // remove the last [DONE] message
    .map(JSON.parse) // parse all of the returned objects
}

/**
 * For streamed responses, we need to accumulate all of the content in
 * the chunks, and let the combined content be the final response.
 * This way, spans look the same as when not streamed.
 */
function wrapStreamIterator (response, options, n, ctx) {
  let processChunksAsBuffers = false
  let chunks = []
  return function (itr) {
    return function () {
      const iterator = itr.apply(this, arguments)
      shimmer.wrap(iterator, 'next', next => function () {
        return next.apply(this, arguments)
          .then(res => {
            const { done, value: chunk } = res

            if (chunk) {
              chunks.push(chunk)
              if (chunk instanceof Buffer) {
                // this operation should be safe
                // if one chunk is a buffer (versus a plain object), the rest should be as well
                processChunksAsBuffers = true
              }
            }

            if (done) {
              let body = {}
              chunks = chunks.filter(chunk => chunk != null) // filter null or undefined values

              if (chunks) {
                if (processChunksAsBuffers) {
                  chunks = convertBufferstoObjects(chunks)
                }

                if (chunks.length) {
                  // define the initial body having all the content outside of choices from the first chunk
                  // this will include import data like created, id, model, etc.
                  body = { ...chunks[0], choices: Array.from({ length: n }) }
                  // start from the first chunk, and add its choices into the body
                  for (let i = 0; i < chunks.length; i++) {
                    addStreamedChunk(body, chunks[i])
                  }
                }
              }

              finish(ctx, {
                headers: response.headers,
                data: body,
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

          // we need to compute how many prompts we are sending in streamed cases for completions
          // not applicable for chat completiond
          let n
          if (stream) {
            n = getOption(arguments, 'n', 1)
            const prompt = getOption(arguments, 'prompt')
            if (Array.isArray(prompt) && typeof prompt[0] !== 'number') {
              n *= prompt.length
            }
          }

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

                  return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, n)
                })

                return unwrappedPromise
              })
            }

            // wrapping `parse` avoids problematic wrapping of `then` when trying to call
            // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
            shimmer.wrap(apiProm, 'parse', origApiPromParse => function () {
              const parsedPromise = origApiPromParse.apply(this, arguments)
                .then(body => Promise.all([this.responsePromise, body]))

              return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, n)
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

function handleUnwrappedAPIPromise (apiProm, ctx, stream, n) {
  return apiProm
    .then(([{ response, options }, body]) => {
      if (stream) {
        if (body.iterator) {
          shimmer.wrap(body, 'iterator', wrapStreamIterator(response, options, n, ctx))
        } else {
          shimmer.wrap(
            body.response.body, Symbol.asyncIterator, wrapStreamIterator(response, options, n, ctx)
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

  ctx.result = response
  ch.asyncEnd.publish(ctx)
}

function getOption (args, option, defaultValue) {
  return args[args.length - 1]?.[option] || defaultValue
}
