'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions.js',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create'],
    streamedResponse: true
  },
  {
    file: 'resources/completions.js',
    targetClass: 'Completions',
    baseResource: 'completions',
    methods: ['create'],
    streamedResponse: true
  },
  {
    file: 'resources/embeddings.js',
    targetClass: 'Embeddings',
    baseResource: 'embeddings',
    methods: ['create']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['create', 'del', 'list', 'retrieve']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['retrieveContent'],
    versions: ['>=4.0.0 <4.17.1']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['content'], // replaced `retrieveContent` in v4.17.1
    versions: ['>=4.17.1']
  },
  {
    file: 'resources/images.js',
    targetClass: 'Images',
    baseResource: 'images',
    methods: ['createVariation', 'edit', 'generate']
  },
  {
    file: 'resources/fine-tuning/jobs/jobs.js',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.34.0'] // file location changed in 4.34.0
  },
  {
    file: 'resources/fine-tuning/jobs.js',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.1.0 <4.34.0']
  },
  {
    file: 'resources/fine-tunes.js', // deprecated after 4.1.0
    targetClass: 'FineTunes',
    baseResource: 'fine-tune',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.0.0 <4.1.0']
  },
  {
    file: 'resources/models.js',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['del', 'list', 'retrieve']
  },
  {
    file: 'resources/moderations.js',
    targetClass: 'Moderations',
    baseResource: 'moderations',
    methods: ['create']
  },
  {
    file: 'resources/audio/transcriptions.js',
    targetClass: 'Transcriptions',
    baseResource: 'audio.transcriptions',
    methods: ['create']
  },
  {
    file: 'resources/audio/translations.js',
    targetClass: 'Translations',
    baseResource: 'audio.translations',
    methods: ['create']
  }
]

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0 <4'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function () {
      if (!startCh.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      startCh.publish({
        methodName,
        args: arguments,
        basePath: this.basePath,
        apiKey: this.configuration.apiKey
      })

      return fn.apply(this, arguments)
        .then((response) => {
          finish({
            headers: response.headers,
            body: response.data,
            path: response.request.path,
            method: response.request.method
          })

          return response
        })
        .catch(error => {
          finish(undefined, error)

          throw error
        })
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
          const oldTool = oldChoice.delta.tool_calls[toolIdx]

          if (oldTool) {
            oldTool.function.arguments += newTool.function.arguments
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
function wrapStreamIterator (response, options, n) {
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

              finish({
                headers: response.headers,
                body,
                path: response.url,
                method: options.method
              })
            }

            return res
          })
          .catch(err => {
            finish(undefined, err)

            throw err
          })
      })
      return iterator
    }
  }
}

for (const shim of V4_PACKAGE_SHIMS) {
  const { file, targetClass, baseResource, methods, versions, streamedResponse } = shim
  addHook({ name: 'openai', file, versions: versions || ['>=4'] }, exports => {
    const targetPrototype = exports[targetClass].prototype

    for (const methodName of methods) {
      shimmer.wrap(targetPrototype, methodName, methodFn => function () {
        if (!startCh.hasSubscribers) {
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

        startCh.publish({
          methodName: `${baseResource}.${methodName}`,
          args: arguments,
          basePath: client.baseURL,
          apiKey: client.apiKey
        })

        const apiProm = methodFn.apply(this, arguments)

        // wrapping `parse` avoids problematic wrapping of `then` when trying to call
        // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
        shimmer.wrap(apiProm, 'parse', origApiPromParse => function () {
          return origApiPromParse.apply(this, arguments)
            // the original response is wrapped in a promise, so we need to unwrap it
            .then(body => Promise.all([this.responsePromise, body]))
            .then(([{ response, options }, body]) => {
              if (stream) {
                if (body.iterator) {
                  shimmer.wrap(body, 'iterator', wrapStreamIterator(response, options, n))
                } else {
                  shimmer.wrap(
                    body.response.body, Symbol.asyncIterator, wrapStreamIterator(response, options, n)
                  )
                }
              } else {
                finish({
                  headers: response.headers,
                  body,
                  path: response.url,
                  method: options.method
                })
              }

              return body
            })
            .catch(error => {
              finish(undefined, error)

              throw error
            })
            .finally(() => {
              // maybe we don't want to unwrap here in case the promise is re-used?
              // other hand: we want to avoid resource leakage
              shimmer.unwrap(apiProm, 'parse')
            })
        })

        return apiProm
      })
    }
    return exports
  })
}

function finish (response, error) {
  if (error) {
    errorCh.publish({ error })
  }

  finishCh.publish(response)
}

function getOption (args, option, defaultValue) {
  return args[args.length - 1]?.[option] || defaultValue
}
