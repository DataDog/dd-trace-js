'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { convertOpenAIResponseItemsToMessages } = require('./helpers/ai-messages')

const ch = dc.tracingChannel('apm:openai:request')
const onStreamedChunkCh = dc.channel('apm:openai:request:chunk')
const evaluateCh = dc.channel('apm:openai:request:evaluate')

const AIGUARD_CONVERSATIONAL_RESOURCES = new Set(['chat.completions', 'responses'])

/**
 * Publishes already-converted AI-style messages to the OpenAI evaluation channel.
 *
 * @param {Array<object>} messages - AI-style messages to evaluate.
 * @returns {Promise<void>}
 */
function publishEvaluation (messages) {
  return new Promise((resolve, reject) => {
    evaluateCh.publish({ messages, resolve, reject })
  })
}

/**
 * Wraps `apiProm.asResponse` so callers that consume the raw `Response` object still
 * receive the Before Model verdict. After Model evaluation is not performed on this
 * path because the response body has not been parsed.
 *
 * @param {object} apiProm - APIPromise returned from the OpenAI SDK method
 * @param {() => Promise<void>} getInputEval - Lazy starter for the Before Model evaluation
 */
function wrapAsResponseForAIGuard (apiProm, getInputEval) {
  if (typeof apiProm.asResponse === 'function') {
    shimmer.wrap(apiProm, 'asResponse', origAsResponse => function () {
      const responsePromise = origAsResponse.apply(this, arguments)
      return Promise.all([getInputEval(), responsePromise]).then(([, response]) => response)
    })
  }
}

/**
 * Extracts OpenAI output messages from parsed response bodies.
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getOutputMessages (baseResource, body) {
  if (baseResource === 'chat.completions') {
    const messages = []
    const choices = Array.isArray(body?.choices) ? body.choices : []
    for (const choice of choices) {
      const message = choice?.message
      // Include the message when it has content (including empty string), tool_calls,
      // or a `refusal` field — GPT-4o emits `{content: null, refusal: "..."}` on policy
      // refusals and AI Guard should still see those.
      if (message?.content != null || message?.tool_calls?.length || message?.refusal != null) {
        messages.push(message)
      }
    }
    return messages
  }

  return convertOpenAIResponseItemsToMessages(body?.output, 'assistant')
}

/**
 * Publishes AI Guard After Model evaluation for extracted OpenAI output messages.
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {Array<object>} inputMessages - Already-converted AI Guard style input messages
 * @param {Array<object>} outputMessages - Already-converted AI Guard style output messages
 * @returns {Promise<void|Array<void>>}
 */
function publishOutputEvaluation (baseResource, inputMessages, outputMessages) {
  if (!outputMessages.length) return Promise.resolve()

  if (baseResource === 'chat.completions') {
    // Chat completions may return multiple choices when `n > 1`. Screen every choice
    // so any unsafe assistant output rejects `.parse()`, regardless of which choice
    // the caller ends up using.
    const evals = []
    for (const message of outputMessages) {
      evals.push(publishEvaluation([...inputMessages, message]))
    }
    return Promise.all(evals)
  }

  return publishEvaluation([...inputMessages, ...outputMessages])
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
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function () {
      if (!ch.start.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      const ctx = {
        methodName,
        args: arguments,
        basePath: this.basePath,
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
        shimmer.wrap(targetPrototype, methodName, methodFn => function () {
          // The OpenAI library lets you set `stream: true` on the options arg to any method
          // However, we only want to handle streamed responses in specific cases
          // chat.completions and completions
          const stream = streamedResponse && getOption(arguments, 'stream', false)

          // Streaming AI Guard support lands in a follow-up PR. For now, provider-level AI
          // Guard only evaluates non-streaming responses.
          const aiguardApplicable = !stream &&
            AIGUARD_CONVERSATIONAL_RESOURCES.has(baseResource) &&
            evaluateCh.hasSubscribers

          if (!ch.start.hasSubscribers && !aiguardApplicable) {
            return methodFn.apply(this, arguments)
          }

          const client = this._client || this.client

          const ctx = {
            methodName: `${baseResource}.${methodName}`,
            args: arguments,
            basePath: client.baseURL,
          }

          // Compute AI Guard input messages before we start the LLM call so Before Model
          // evaluation can run in parallel with it once the caller awaits the APIPromise.
          let aiguardInputMessages
          if (aiguardApplicable) {
            const callArgs = arguments[0]
            const messages = baseResource === 'chat.completions'
              ? Array.isArray(callArgs?.messages) ? callArgs.messages : undefined
              : convertOpenAIResponseItemsToMessages(callArgs?.input, 'user')
            if (messages?.length) aiguardInputMessages = messages
          }

          return ch.start.runStores(ctx, () => {
            const apiProm = methodFn.apply(this, arguments)

            // Lazy, memoized Before Model evaluation. The promise is started the first time
            // any of the wrapped APIPromise methods (`parse`, `_thenUnwrap.parse`, `asResponse`)
            // is invoked, and re-used by all subsequent observers. This mirrors the Vercel AI
            // pattern: the input-eval promise is always part of the chain that the caller
            // awaits, so there is no fire-and-forget rejection to silence.
            let inputEvalPromise
            const getInputEval = aiguardInputMessages
              ? () => (inputEvalPromise ??= publishEvaluation(aiguardInputMessages))
              : null

            const aiguard = getInputEval
              ? { baseResource, inputMessages: aiguardInputMessages, getInputEval }
              : undefined

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

                  return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, aiguard)
                })

                return unwrappedPromise
              })
            }

            // wrapping `parse` avoids problematic wrapping of `then` when trying to call
            // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
            shimmer.wrap(apiProm, 'parse', origApiPromParse => function () {
              const parsedPromise = origApiPromParse.apply(this, arguments)
                .then(body => Promise.all([this.responsePromise, body]))

              return handleUnwrappedAPIPromise(parsedPromise, ctx, stream, aiguard)
            })

            if (getInputEval) {
              wrapAsResponseForAIGuard(apiProm, getInputEval)
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

function handleUnwrappedAPIPromise (apiProm, ctx, stream, aiguard) {
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

      if (!aiguard) return body
      return aiguard.getInputEval()
        .then(() => getOutputMessages(aiguard.baseResource, body))
        .then(outputMessages => publishOutputEvaluation(aiguard.baseResource, aiguard.inputMessages, outputMessages))
        .then(() => body)
    }, error => {
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
