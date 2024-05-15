'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions.js',
    targetClass: 'Completions',
    baseResource: 'chat.completions',
    methods: ['create']
  },
  {
    file: 'resources/completions.js',
    targetClass: 'Completions',
    baseResource: 'completions',
    methods: ['create']
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
          finishCh.publish({
            headers: response.headers,
            body: response.data,
            path: response.request.path,
            method: response.request.method
          })

          return response
        })
        .catch((err) => {
          errorCh.publish({ err })

          throw err
        })
    })
  }

  return exports
})

function addStreamedChunk (content, chunk) {
  return content.choices.map((oldChoice, choiceIdx) => {
    const newChoice = oldChoice
    const chunkChoice = chunk.choices[choiceIdx]
    if (!oldChoice.finish_reason) {
      newChoice.finish_reason = chunkChoice.finish_reason
    }

    // delta exists on chat completions
    const delta = chunkChoice.delta

    if (delta) {
      const content = delta.content
      if (content) {
        if (newChoice.delta.content) { // we don't want to append to undefined
          newChoice.delta.content += content
        } else {
          newChoice.delta.content = content
        }
      }
    } else {
      const text = chunkChoice.text
      if (text) {
        if (newChoice.text) {
          newChoice.text += text
        } else {
          newChoice.text = text
        }
      }
    }

    // tools only exist on chat completions
    const tools = delta && chunkChoice.delta.tool_calls

    if (tools) {
      newChoice.delta.tool_calls = tools.map((newTool, toolIdx) => {
        const oldTool = oldChoice.delta.tool_calls[toolIdx]

        if (oldTool) {
          oldTool.function.arguments += newTool.function.arguments
        }

        return oldTool
      })
    }

    return newChoice
  })
}

function wrapStreamIterator (body, response, options) {
  let content // the total build up of the response
  return function (itr) {
    return function () {
      const iterator = itr.apply(this, arguments)
      shimmer.wrap(iterator, 'next', next => function () {
        return next.apply(this, arguments)
          .then(res => {
            const { done, value: chunk } = res

            if (!content) {
              content = chunk
            } else if (chunk) {
              if (chunk instanceof Buffer) {
                // we need to skip adding the chunk I think...
              } else {
                content.choices = addStreamedChunk(content, chunk)
              }
            }

            if (done) {
              finishCh.publish({
                headers: response.headers,
                body: content,
                path: response.url,
                method: options.method
              })
            }

            return res
          })
          .catch(err => {
            errorCh.publish({ err })

            throw err
          })
          .finally(() => {
            shimmer.unwrap(body, 'iterator')
            shimmer.unwrap(iterator, 'next')
          })
      })
      return iterator
    }
  }
}

for (const shim of V4_PACKAGE_SHIMS) {
  const { file, targetClass, baseResource, methods } = shim
  addHook({ name: 'openai', file, versions: shim.versions || ['>=4'] }, exports => {
    const targetPrototype = exports[targetClass].prototype

    for (const methodName of methods) {
      shimmer.wrap(targetPrototype, methodName, methodFn => function () {
        if (!startCh.hasSubscribers) {
          return methodFn.apply(this, arguments)
        }

        const stream = arguments[0].stream

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
                  shimmer.wrap(body, 'iterator', wrapStreamIterator(body, response, options))
                } else {
                  log.warn('Streamed responses using Buffers are not supported')
                  finishCh.publish({
                    headers: response.headers,
                    body: undefined,
                    path: response.url,
                    method: options.method
                  })
                  // shimmer.wrap(
                  //   body.response.body, Symbol.asyncIterator, wrapStreamIterator(body, response, options)
                  // )
                }
              } else {
                finishCh.publish({
                  headers: response.headers,
                  body,
                  path: response.url,
                  method: options.method
                })
              }

              return body
            })
            .catch(err => {
              errorCh.publish({ err })

              throw err
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
