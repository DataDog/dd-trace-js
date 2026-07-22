'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')

const {
  FakeAPIPromise,
  FakeMessages,
  applyShim,
  createDeferred,
  loadAnthropicInstrumentation,
} = require('../helpers/anthropic-lifecycle')

const mode = process.argv[2]
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

async function run () {
  const Messages = class extends FakeMessages {}
  applyShim(loadAnthropicInstrumentation(), 'resources/messages/messages', Messages)

  const messages = new Messages()
  const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
  messages._nextApiPromise = apiPromise

  if (mode === 'caught-after-verdict') {
    const error = new Error('blocked')
    /**
     * @param {{ abortController: AbortController, pending: Promise<void>[] }} context
     */
    const blockingSubscriber = context => {
      context.abortController.abort(error)
      context.pending.push(Promise.resolve())
    }
    messagesAfterChannel.subscribe(blockingSubscriber)

    try {
      await assert.rejects(messages.create({ messages: [] }).parse(), error)
    } finally {
      messagesAfterChannel.unsubscribe(blockingSubscriber)
    }
    return
  }

  if (mode === 'ignored-parse-error' || mode === 'ignored-parse-error-with-raw') {
    /**
     * @param {{ pending: Promise<void>[] }} context
     */
    const subscriber = context => {
      context.pending.push(Promise.resolve())
    }
    messagesAfterChannel.subscribe(subscriber)
    apiPromise.parse = () => Promise.reject(new SyntaxError('invalid response'))
    const instrumentedPromise = messages.create({ messages: [] })
    instrumentedPromise.parse()

    if (mode === 'ignored-parse-error-with-raw') {
      await instrumentedPromise.asResponse()
    }

    await setImmediate()
    messagesAfterChannel.unsubscribe(subscriber)
    return
  }

  if (mode === 'ignored-first-raw') {
    const error = new Error('blocked')
    /**
     * @param {{ abortController: AbortController, pending: Promise<void>[] }} context
     */
    const subscriber = context => {
      context.abortController.abort(error)
      context.pending.push(Promise.resolve())
    }
    messagesAfterChannel.subscribe(subscriber)
    const instrumentedPromise = messages.create({ messages: [] })
    instrumentedPromise.asResponse()

    try {
      await assert.rejects(instrumentedPromise.asResponse(), error)
      await setImmediate()
    } finally {
      messagesAfterChannel.unsubscribe(subscriber)
    }
    return
  }

  if (mode === 'raw-with-pending-parse') {
    const parseDeferred = createDeferred()
    /**
     * @param {{ pending: Promise<void>[] }} context
     */
    const subscriber = context => {
      context.pending.push(Promise.resolve())
    }
    messagesAfterChannel.subscribe(subscriber)
    apiPromise.parse = () => parseDeferred.promise
    const instrumentedPromise = messages.create({ messages: [] })
    const parsePromise = instrumentedPromise.parse()
    let rawResponse

    try {
      instrumentedPromise.asResponse().then(
        /**
         * @param {object} response
         */
        response => {
          rawResponse = response
        }
      )
      await setImmediate()
      assert.strictEqual(rawResponse, apiPromise._rawResponse)

      parseDeferred.resolve(apiPromise._body)
      await parsePromise
    } finally {
      messagesAfterChannel.unsubscribe(subscriber)
    }
    return
  }

  throw new Error(`Unknown mode: ${mode}`)
}

run()
