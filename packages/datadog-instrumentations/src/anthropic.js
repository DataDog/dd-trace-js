'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
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

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {Promise<void>|undefined} verdict
 * @returns {Promise<T>}
 */
function waitForVerdict (promise, verdict) {
  if (!verdict) return promise

  // Enforce the input verdict first: a denial must surface as AIGuardAbortError even when the SDK
  // request rejects first. Promise.all would report whichever settles first, so a provider/network
  // failure could mask the block. Observe the SDK rejection here so a denial leaves no unhandled one.
  promise.catch(() => {})
  return verdict.then(() => promise)
}

/**
 * @param {Array<unknown>} args
 * @returns {Array<unknown>|undefined}
 */
function snapshotLifecycleArgs (args) {
  const options = args[0]
  if (!options || typeof options !== 'object') return

  const input = { messages: options.messages }
  if (options.system !== undefined) input.system = options.system

  try {
    const snapshot = [...args]
    snapshot[0] = { ...options, ...structuredClone(input) }
    return snapshot
  } catch {
    // Evaluating mutable input could inspect a different prompt than the provider received.
  }
}

/**
 * Runs the output verdict for a parsed response and finishes the span with it. Finishing after the
 * verdict lets a block propagate to anthropic.request and keeps the span wrapping its child.
 *
 * @param {object} ctx
 * @param {object} result
 * @param {(body: object) => Promise<void>|undefined} getVerdict
 * @param {object|string} [returnedResult]
 * @returns {object|string|Promise<object|string>}
 */
function finishResult (ctx, result, getVerdict, returnedResult = result) {
  const verdict = getVerdict(result)
  if (!verdict) {
    finish(ctx, result, null)
    return returnedResult
  }

  return verdict.then(() => {
    finish(ctx, result, null)
    return returnedResult
  })
}

/**
 * @param {object} response
 * @param {'json'|'text'} method
 * @param {object} ctx
 * @param {(body: object) => Promise<void>|undefined} getVerdict
 */
function wrapResponseReader (response, method, ctx, getVerdict) {
  if (typeof response[method] !== 'function') return

  shimmer.wrap(response, method, original => function (...args) {
    return original.apply(this, args)
      .then(body => {
        if (method === 'json') return finishResult(ctx, body, getVerdict)

        try {
          return finishResult(ctx, JSON.parse(body), getVerdict, body)
        } catch {
          finish(ctx)
          return body
        }
      })
      .catch(error => {
        if (!ctx.finished) finish(ctx, null, error)
        throw error
      })
  })
}

/**
 * @param {object} response
 * @param {object} ctx
 * @param {(body: object) => Promise<void>|undefined} getVerdict
 */
function wrapRawResponse (response, ctx, getVerdict) {
  wrapResponseReader(response, 'json', ctx, getVerdict)
  wrapResponseReader(response, 'text', ctx, getVerdict)

  if (typeof response.clone !== 'function') return

  shimmer.wrap(response, 'clone', clone => function (...args) {
    const clonedResponse = clone.apply(this, args)
    wrapRawResponse(clonedResponse, ctx, getVerdict)
    return clonedResponse
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

    // Streaming is  out of scope for lifecycle evaluation
    const lifecycleRequested = !stream &&
      (messagesBeforeChannel.hasSubscribers || messagesAfterChannel.hasSubscribers)
    const lifecycleArgs = lifecycleRequested ? snapshotLifecycleArgs(args) : undefined
    const hasLifecycle = lifecycleArgs !== undefined

    if (!anthropicTracingChannel.start.hasSubscribers && !hasLifecycle) {
      return create.apply(this, args)
    }

    const ctx = { options, resource: 'create', baseUrl: this._client?.baseURL }

    return anthropicTracingChannel.start.runStores(ctx, () => {
      const parentSpan = hasLifecycle ? ctx.currentStore?.span : undefined

      let apiPromise
      try {
        // Anthropic starts the request eagerly; the input verdict only gates result delivery.
        apiPromise = create.apply(this, lifecycleArgs ?? args)
      } catch (error) {
        finish(ctx, null, error)
        throw error
      }

      let afterVerdict
      let parseResult
      let wrappedResponse

      let beforeVerdict
      function getBeforeVerdict () {
        if (!hasLifecycle || beforeVerdict) return beforeVerdict
        if (!messagesBeforeChannel.hasSubscribers) return

        beforeVerdict = publishLifecycle(messagesBeforeChannel, { args: lifecycleArgs, parentSpan })
        return beforeVerdict
      }

      /**
       * @param {object|string} body
       */
      function getAfterVerdict (body) {
        if (!hasLifecycle || afterVerdict) return afterVerdict
        if (!messagesAfterChannel.hasSubscribers) return

        afterVerdict = publishLifecycle(messagesAfterChannel, { args: lifecycleArgs, body, parentSpan })
        return afterVerdict
      }

      shimmer.wrap(apiPromise, 'parse', parse => function (...parseArgs) {
        if (parseResult) return parseResult

        const parsed = parse.apply(this, parseArgs)
        parseResult = waitForVerdict(parsed, getBeforeVerdict())
          .then(response => {
            if (stream) {
              shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
              return response
            }
            return finishResult(ctx, response, getAfterVerdict)
          }).catch(error => {
            if (!ctx.finished) finish(ctx, null, error)
            throw error
          })

        return parseResult
      })

      if (typeof apiPromise.asResponse === 'function') {
        shimmer.wrap(apiPromise, 'asResponse', origAsResponse => function (...asResponseArgs) {
          return waitForVerdict(origAsResponse.apply(this, asResponseArgs), getBeforeVerdict())
            .then(response => {
              // Raw output evaluation supports the common json() and text() readers only.
              if (!stream &&
                (anthropicTracingChannel.start.hasSubscribers ||
                  afterVerdict ||
                  messagesAfterChannel.hasSubscribers) &&
                wrappedResponse !== response) {
                wrappedResponse = response
                wrapRawResponse(response, ctx, getAfterVerdict)
              }

              if (afterVerdict) return afterVerdict.then(() => response)
              return response
            })
            .catch(error => {
              if (!ctx.finished) finish(ctx, null, error)
              throw error
            })
        })
      }

      anthropicTracingChannel.end.publish(ctx)

      return apiPromise
    })
  }
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
