'use strict'

const OpenAiBaseEndpointHook = require('./base')
const { DD_MAJOR } = require('../../../../version')
const satisfies = require('semifies')
const shimmer = require('../../../datadog-shimmer')

const { addStreamedChunk, convertBuffersToObjects } = require('../streaming')

function tryRequire (path) {
  try {
    return require(path)
  } catch (e) {
    return null
  }
}

const OPENAI_VERSION = tryRequire('openai/version')

class OpenAiCompletionsEndpointHook extends OpenAiBaseEndpointHook {
  static get id () { return 'openai:completions' }
  static get resource () { return 'createCompletion' }
  static get prefix () {
    return 'tracing:orchestrion:openai:Completions_create'
  }

  getResource () {
    if (DD_MAJOR <= 5 && satisfies(OPENAI_VERSION, '>=4.0.0')) {
      return 'chat.completions.create'
    } else {
      return 'createCompletion'
    }
  }

  end (ctx) {
    const stream = ctx.arguments?.[0].stream

    if (!stream) return super.end(ctx)

    // handle the stream --> needs wrapping?
    const span = ctx.currentStore?.span
    if (!span) return

    const { result } = ctx

    const n = getOption(ctx.arguments, 'n', 1)

    const plugin = this

    // we need to wrap the stream that the user will consume
    // the stream is just a generator function, and each chunk could either be a buffer or an object

    // we cannot separately tee and consume the stream, as to accurately represent the execution time
    // in the users application - we wrap the stream for this reason

    // also this is messy - just copied from the existing instrumentation
    // it needs to be cleaned up
    shimmer.wrap(result, 'parse', parse => function () {
      return parse.apply(this, arguments)
        .then(body => Promise.all([this.responsePromise, body]))
        .then(([{ response, options }, body]) => {
          shimmer.wrap(body, Symbol.asyncIterator, asyncIterator => function () {
            const iterator = asyncIterator.apply(this, arguments)

            let chunks = []
            let processChunksAsBuffers = false
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
                        chunks = convertBuffersToObjects(chunks)
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

                    // use  headers, response, options, and computed body to set finish tags
                    span.finish() // TODO do other processing here
                  }

                  return res
                })
                .catch(err => {
                  plugin.addError(err, span)

                  throw err
                })
            })
            return iterator
          })
          return body
        })
    })
  }
}

function getOption (args, option, defaultValue) {
  return args?.[0]?.[option] || defaultValue
}

module.exports = OpenAiCompletionsEndpointHook
