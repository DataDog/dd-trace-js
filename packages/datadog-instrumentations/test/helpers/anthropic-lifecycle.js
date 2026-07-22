'use strict'

class FakeAPIPromise {
  /**
   * @param {object} body
   */
  constructor (body) {
    this._body = body
    this._rawResponse = new Response(JSON.stringify(body))
  }

  /**
   * @returns {Promise<object>}
   */
  parse () {
    return Promise.resolve(this._body)
  }

  /**
   * @returns {Promise<Response>}
   */
  asResponse () {
    return Promise.resolve(this._rawResponse)
  }

  /**
   * @returns {Promise<{ data: object, response: Response }>}
   */
  withResponse () {
    return Promise.all([this.parse(), this.asResponse()]).then(([data, response]) => ({ data, response }))
  }

  /**
   * @param {(value: object) => unknown} [onFulfilled]
   * @param {(reason: unknown) => unknown} [onRejected]
   * @returns {Promise<unknown>}
   */
  then (onFulfilled, onRejected) {
    return this.parse().then(onFulfilled, onRejected)
  }
}

class FakeMessages {
  /**
   * @returns {FakeAPIPromise}
   */
  create () {
    return this._nextApiPromise
  }
}

/**
 * @template T
 * @returns {{
 *   promise: Promise<T | undefined>,
 *   reject: (reason?: unknown) => void,
 *   resolve: (value?: T | PromiseLike<T>) => void
 * }}
 */
function createDeferred () {
  let rejectDeferred
  let resolveDeferred
  const promise = new Promise((resolve, reject) => {
    rejectDeferred = reject
    resolveDeferred = resolve
  })
  return { promise, reject: rejectDeferred, resolve: resolveDeferred }
}

/**
 * @returns {Array<{ spec: { file: string }, callback: (exports: object) => object }>}
 */
function loadAnthropicInstrumentation () {
  const instrumentPath = require.resolve('../../src/helpers/instrument')
  const realInstrument = require(instrumentPath)
  const hookCallbacks = []
  const cache = require.cache[instrumentPath]
  const previousExports = cache.exports

  cache.exports = {
    ...realInstrument,
    /**
     * @param {{ file: string }} spec
     * @param {(exports: object) => object} callback
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
 * @param {Array<{ spec: { file: string }, callback: (exports: object) => object }>} hookCallbacks
 * @param {string} filePath
 * @param {typeof FakeMessages} Messages
 */
function applyShim (hookCallbacks, filePath, Messages) {
  for (const { spec, callback } of hookCallbacks) {
    if (spec.file === `${filePath}.js`) {
      callback({ Messages })
      return
    }
  }
  throw new Error(`No hook registered for ${filePath}.js`)
}

module.exports = {
  FakeAPIPromise,
  FakeMessages,
  applyShim,
  createDeferred,
  loadAnthropicInstrumentation,
}
