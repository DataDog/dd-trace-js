'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')

const mode = process.argv[2]
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

class FakeAPIPromise {
  /**
   * @param {object} body
   */
  constructor (body) {
    this.body = body
    this.response = new Response(JSON.stringify(body))
  }

  parse () {
    return Promise.resolve(this.body)
  }

  asResponse () {
    return Promise.resolve(this.response)
  }
}

class Messages {
  create () {
    return this.apiPromise
  }
}

function loadAnthropicInstrumentation () {
  const instrumentPath = require.resolve('../../src/helpers/instrument')
  const realInstrument = require(instrumentPath)
  const hookCallbacks = []
  const cache = require.cache[instrumentPath]
  const previousExports = cache.exports

  cache.exports = {
    ...realInstrument,
    /**
     * @param {object} spec
     * @param {Function} callback
     */
    addHook (spec, callback) {
      hookCallbacks.push({ spec, callback })
    },
  }

  try {
    delete require.cache[require.resolve('../../src/anthropic')]
    require('../../src/anthropic')
  } finally {
    cache.exports = previousExports
  }

  return hookCallbacks
}

/**
 * @param {Array<{ spec: object, callback: Function }>} hookCallbacks
 */
function applyShim (hookCallbacks) {
  for (const { spec, callback } of hookCallbacks) {
    if (spec.file === 'resources/messages/messages.js') {
      callback({ Messages })
      return
    }
  }
  throw new Error('Anthropic messages hook not registered')
}

function createDeferred () {
  let resolveDeferred
  const promise = new Promise(
    /**
     * @param {(value: object) => void} resolve
     */
    resolve => {
      resolveDeferred = resolve
    }
  )
  return { promise, resolve: resolveDeferred }
}

async function run () {
  applyShim(loadAnthropicInstrumentation())

  const messages = new Messages()
  const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
  messages.apiPromise = apiPromise

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
      assert.strictEqual(rawResponse, apiPromise.response)

      parseDeferred.resolve(apiPromise.body)
      await parsePromise
    } finally {
      messagesAfterChannel.unsubscribe(subscriber)
    }
    return
  }

  throw new Error(`Unknown mode: ${mode}`)
}

run()
