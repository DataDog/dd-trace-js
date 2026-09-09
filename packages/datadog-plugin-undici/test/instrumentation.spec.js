'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const satisfies = require('../../../vendor/dist/semifies')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
require('../../datadog-instrumentations/src/undici')

const nativeEvents = []

/** @param {object} message */
function publishHeaders (message) {
  nativeEvents.push({ name: 'headers', message })
}

/** @param {object} message */
function publishTrailers (message) {
  nativeEvents.push({ name: 'trailers', message })
}

const channels = {
  headers: { hasSubscribers: true, publish: publishHeaders },
  trailers: { hasSubscribers: true, publish: publishTrailers },
}

function createPreDiagnosticRequest () {
  return class Request {
    /**
     * @param {number} statusCode
     * @param {unknown} headers
     * @param {unknown} socket
     */
    onUpgrade (statusCode, headers, socket) {
      return socket
    }
  }
}

function createLegacyRequest () {
  return class Request {
    /** @param {object} handler */
    constructor (handler) {
      this.handler = handler
    }

    /**
     * @param {number} statusCode
     * @param {unknown} headers
     * @param {unknown} socket
     */
    onUpgrade (statusCode, headers, socket) {
      return this.handler.onUpgrade(statusCode, headers, socket)
    }

    /** @param {unknown} trailers */
    onComplete (trailers) {
      channels.trailers.publish({ request: this, trailers })
    }
  }
}

function createCurrentRequest () {
  return class Request {
    /**
     * @param {object} handler
     * @param {object} controller
     */
    constructor (handler, controller) {
      this.controller = controller
      this.handler = handler
    }

    /**
     * @param {number} statusCode
     * @param {unknown} headers
     * @param {unknown} socket
     */
    onRequestUpgrade (statusCode, headers, socket) {
      return this.handler.onRequestUpgrade(this.controller, statusCode, headers, socket)
    }

    /** @param {unknown} trailers */
    onResponseEnd (trailers) {
      channels.trailers.publish({ request: this, trailers })
    }
  }
}

function createFixedLegacyRequest () {
  return class Request {
    /** @param {object} handler */
    constructor (handler) {
      this.handler = handler
    }

    /**
     * @param {number} statusCode
     * @param {unknown} headers
     * @param {unknown} socket
     */
    onUpgrade (statusCode, headers, socket) {
      channels.headers.publish({ request: this, response: { statusCode, headers } })
      const result = this.handler.onUpgrade(statusCode, headers, socket)
      this.completed = true
      channels.trailers.publish({ request: this, trailers: [] })
      return result
    }
  }
}

function createFixedCurrentRequest () {
  return class Request {
    /**
     * @param {object} handler
     * @param {object} controller
     */
    constructor (handler, controller) {
      this.controller = controller
      this.handler = handler
    }

    /**
     * @param {number} statusCode
     * @param {unknown} headers
     * @param {unknown} socket
     */
    onRequestUpgrade (statusCode, headers, socket) {
      channels.headers.publish({ request: this, response: { statusCode, headers } })
      const result = this.handler.onRequestUpgrade(this.controller, statusCode, headers, socket)
      this.completed = true
      channels.trailers.publish({ request: this, trailers: [] })
      return result
    }
  }
}

const upgradeChannel = channel('apm:undici:request:upgrade')
const cases = [
  { version: '4.7.0', methodName: 'onUpgrade', createRequest: createLegacyRequest },
  { version: '5.0.0', methodName: 'onUpgrade', createRequest: createLegacyRequest },
  { version: '7.29.0', methodName: 'onUpgrade', createRequest: createLegacyRequest },
  { version: '8.0.0', methodName: 'onRequestUpgrade', createRequest: createCurrentRequest },
  { version: '8.10.0', methodName: 'onRequestUpgrade', createRequest: createCurrentRequest },
]

/**
 * @param {string} version
 * @param {Function} Request
 */
function applyRequestHooks (version, Request) {
  for (const { file, hook, versions } of instrumentations.undici) {
    if (file !== 'lib/core/request.js') continue
    if (!versions || versions.some(range => satisfies(version, range))) hook(Request, version)
  }
}

/**
 * @param {unknown[]} actual
 * @param {unknown[]} expected
 */
function assertArgumentIdentity (actual, expected) {
  assert.strictEqual(actual.length, expected.length)
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(actual[i], expected[i])
  }
}

/**
 * @param {string} methodName
 * @param {unknown} result
 * @param {unknown[][]} calls
 * @param {Error} [error]
 * @returns {object}
 */
function createHandler (methodName, result, calls, error) {
  return {
    [methodName] (...args) {
      calls.push(args)
      if (error) throw error
      return result
    },
  }
}

describe('undici instrumentation', () => {
  it('does not wrap versions without native request diagnostics', () => {
    const Request = createPreDiagnosticRequest()
    const original = Request.prototype.onUpgrade

    applyRequestHooks('4.4.1', Request)

    assert.strictEqual(Request.prototype.onUpgrade, original)
  })

  for (const { version, methodName, createRequest } of cases) {
    for (const subscriberFirst of [true, false]) {
      const loadOrder = subscriberFirst ? 'subscriber first' : 'hook first'

      it(`wraps broken ${version} ${methodName} implementations with the ${loadOrder}`, () => {
        const Request = createRequest()
        const calls = []
        const messages = []
        const result = {}
        const controller = {}
        const headers = ['upgrade', 'test']
        const socket = {}
        const handler = createHandler(methodName, result, calls)
        const subscriber = message => messages.push(message)
        const expectedArguments = methodName === 'onRequestUpgrade'
          ? [controller, 101, headers, socket]
          : [101, headers, socket]

        if (subscriberFirst) upgradeChannel.subscribe(subscriber)
        applyRequestHooks(version, Request)

        try {
          if (!subscriberFirst) {
            const publish = sinon.spy(upgradeChannel, 'publish')
            const inactiveRequest = new Request(handler, controller)

            try {
              assert.strictEqual(inactiveRequest[methodName](101, headers, socket), result)
              sinon.assert.notCalled(publish)
              assert.strictEqual(calls.length, 1)
              assertArgumentIdentity(calls[0], expectedArguments)
            } finally {
              publish.restore()
            }
            upgradeChannel.subscribe(subscriber)
          }

          const request = new Request(handler, controller)
          assert.strictEqual(request[methodName](101, headers, socket), result)
          assert.deepStrictEqual(messages, [{ headers, request, statusCode: 101 }])
          assert.strictEqual(calls.length, subscriberFirst ? 1 : 2)

          assertArgumentIdentity(calls.at(-1), expectedArguments)

          const expectedError = new Error('upgrade failed')
          const throwingHandler = createHandler(methodName, result, [], expectedError)
          const throwingRequest = new Request(throwingHandler, controller)
          assert.throws(
            () => throwingRequest[methodName](101, headers, socket),
            error => error === expectedError
          )
          assert.deepStrictEqual(messages.at(-1), {
            error: expectedError,
            headers,
            request: throwingRequest,
            statusCode: 101,
          })

          const abortingHandler = {
            [methodName] () {
              abortedRequest.aborted = true
              return result
            },
          }
          const abortedRequest = new Request(abortingHandler, controller)
          assert.strictEqual(abortedRequest[methodName](101, headers, socket), result)
          assert.strictEqual(messages.length, 2)
        } finally {
          upgradeChannel.unsubscribe(subscriber)
        }
      })
    }
  }

  for (const { version, methodName } of cases) {
    for (const subscriberFirst of [true, false]) {
      const createRequest = methodName === 'onRequestUpgrade' ? createFixedCurrentRequest : createFixedLegacyRequest
      const loadOrder = subscriberFirst ? 'subscriber first' : 'hook first'

      it(`does not wrap fixed ${version} ${methodName} implementations with the ${loadOrder}`, () => {
        nativeEvents.length = 0
        const Request = createRequest()
        const fallbackMessages = []
        const result = {}
        const controller = {}
        const headers = ['upgrade', 'test']
        const socket = {}
        const handlerCalls = []
        const handler = createHandler(methodName, result, handlerCalls)
        const subscriber = message => fallbackMessages.push(message)
        const original = Request.prototype[methodName]

        if (subscriberFirst) upgradeChannel.subscribe(subscriber)
        applyRequestHooks(version, Request)
        if (!subscriberFirst) upgradeChannel.subscribe(subscriber)

        try {
          assert.strictEqual(Request.prototype[methodName], original)

          const request = new Request(handler, controller)
          assert.strictEqual(request[methodName](101, headers, socket), result)
          assert.strictEqual(request.completed, true)
          assert.deepStrictEqual(fallbackMessages, [])
          assert.deepStrictEqual(nativeEvents, [
            { name: 'headers', message: { request, response: { statusCode: 101, headers } } },
            { name: 'trailers', message: { request, trailers: [] } },
          ])
          assert.strictEqual(handlerCalls.length, 1)

          const expectedArguments = methodName === 'onRequestUpgrade'
            ? [controller, 101, headers, socket]
            : [101, headers, socket]
          assertArgumentIdentity(handlerCalls[0], expectedArguments)
        } finally {
          upgradeChannel.unsubscribe(subscriber)
        }
      })
    }
  }
})
