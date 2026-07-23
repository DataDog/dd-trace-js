'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { addHook } = require('./helpers/instrument')

const anthropicTracingChannel = tracingChannel('apm:anthropic:request')
const onStreamedChunkCh = channel('apm:anthropic:request:chunk')
const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

/**
 * Publishes a provider-native lifecycle payload to a cancelable lifecycle channel.
 *
 * Subscribers push async work into `pending` synchronously during publication and
 * abort `abortController` with an error before the pushed promise resolves to block.
 *
 * @param {object} channel
 * @param {object} payload
 * @returns {Promise<void>}
 */
function publishLifecycle (channel, payload) {
  const abortController = new AbortController()
  const ctx = { ...payload, abortController, pending: [] }

  channel.publish(ctx)

  return Promise.all(ctx.pending).then(() => {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason
    }
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
    const options = args[0]
    const stream = options?.stream

    const hasLifecycle = !stream && (messagesBeforeChannel.hasSubscribers || messagesAfterChannel.hasSubscribers)

    if (!anthropicTracingChannel.start.hasSubscribers && !hasLifecycle) {
      return create.apply(this, args)
    }

    const ctx = { options, resource: 'create', baseUrl: this._client?.baseURL }

    return anthropicTracingChannel.start.runStores(ctx, () => {
      const parentSpan = hasLifecycle ? ctx.currentStore?.span : undefined

      let apiPromise
      try {
        apiPromise = create.apply(this, args)
      } catch (error) {
        finish(ctx, null, error)
        throw error
      }

      let afterVerdict
      let beforeVerdict
      let parseResult
      let rawResponseRead

      function getBeforeVerdict () {
        if (!hasLifecycle || beforeVerdict) return beforeVerdict
        if (!messagesBeforeChannel.hasSubscribers) return

        beforeVerdict = publishLifecycle(messagesBeforeChannel, { args, parentSpan })
        return beforeVerdict
      }

      /**
       * @param {object|string} body
       */
      function getAfterVerdict (body) {
        if (!hasLifecycle || afterVerdict) return afterVerdict
        if (!messagesAfterChannel.hasSubscribers) return

        afterVerdict = publishLifecycle(messagesAfterChannel, { args, body, parentSpan })
        return afterVerdict
      }

      shimmer.wrap(apiPromise, 'parse', parse => function (...parseArgs) {
        if (parseResult) return parseResult

        const parsed = parse.apply(this, parseArgs)
        const verdict = getBeforeVerdict()
        const parsedAfterBeforeVerdict = verdict
          ? Promise.all([verdict, parsed]).then(([, response]) => response)
          : parsed

        parseResult = parsedAfterBeforeVerdict
          .then(response => {
            if (stream) {
              shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
              return response
            }
            const verdict = getAfterVerdict(response)
            if (!verdict) {
              finish(ctx, response, null)
              return response
            }
            // Finish after evaluation so a block propagates the error to anthropic.request
            // and the span wraps its child instead of closing before it.
            return verdict.then(() => {
              finish(ctx, response, null)
              return response
            })
          }).catch(error => {
            if (!ctx.finished) finish(ctx, null, error)
            throw error
          })

        return parseResult
      })

      // Gate `.asResponse()` callers on the before verdict so raw-response paths still block,
      // and inspect a clone so the caller's response stays unconsumed.
      shimmer.wrap(apiPromise, 'asResponse', origAsResponse => function (...asResponseArgs) {
        const responsePromise = origAsResponse.apply(this, asResponseArgs)
        const verdict = hasLifecycle ? getBeforeVerdict() : undefined
        const gated = verdict
          ? Promise.all([verdict, responsePromise]).then(([, response]) => response)
          : responsePromise

        return gated
          .then(response => {
            if (!stream && hasLifecycle) {
              if (afterVerdict) {
                return afterVerdict.then(() => response)
              }

              if (rawResponseRead) {
                return rawResponseRead
              }

              if (messagesAfterChannel.hasSubscribers) {
                if (parseResult && response.bodyUsed) return response

                // node-fetch clones backpressure when the original branch is unread.
                if (typeof response.body?.pipe === 'function') {
                  /**
                   * @param {(...args: unknown[]) => Promise<object|string>} originalMethod
                   * @returns {(...args: unknown[]) => Promise<object|string>}
                   */
                  function wrapBodyConsume (originalMethod) {
                    return function (...methodArgs) {
                      return originalMethod.apply(this, methodArgs).then(body => {
                        const verdict = getAfterVerdict(body)
                        return verdict ? verdict.then(() => body) : body
                      })
                    }
                  }

                  if (typeof response.json === 'function') {
                    shimmer.wrap(response, 'json', wrapBodyConsume)
                  }
                  if (typeof response.text === 'function') {
                    shimmer.wrap(response, 'text', wrapBodyConsume)
                  }

                  rawResponseRead = Promise.resolve(response)
                  if (!parseResult) finish(ctx)
                  return rawResponseRead
                }

                let bodyPromise
                try {
                  bodyPromise = response.clone().text()
                } catch {
                  handleRawResponseReadError(ctx, !parseResult)
                  rawResponseRead = Promise.resolve(response)
                  return rawResponseRead
                }

                rawResponseRead = bodyPromise.then(
                  /**
                   * @param {string} body
                   */
                  body => {
                    const verdict = getAfterVerdict(body)
                    if (!verdict) {
                      if (!parseResult) finish(ctx, body, null)
                      return response
                    }

                    return verdict.then(() => {
                      if (!parseResult) finish(ctx, body, null)
                      return response
                    })
                  },
                  () => {
                    handleRawResponseReadError(ctx, !parseResult && !afterVerdict)
                    if (afterVerdict) return afterVerdict.then(() => response)
                    return response
                  }
                )
                return rawResponseRead
              }
            }

            if (!stream && !ctx.finished && !parseResult) finish(ctx, null, null)
            return response
          })
          .catch(error => {
            if (!ctx.finished) finish(ctx, null, error)
            throw error
          })
      })

      anthropicTracingChannel.end.publish(ctx)

      return apiPromise
    })
  }
}

/**
 * @param {object} ctx
 * @param {boolean} finishSpan
 */
function handleRawResponseReadError (ctx, finishSpan) {
  if (!finishSpan) return

  log.error('Unable to read Anthropic response body')
  finish(ctx)
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
