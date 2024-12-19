'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const cryptoHashCh = channel('datadog:crypto:hashing:start')
const cryptoCipherCh = channel('datadog:crypto:cipher:start')

const hashMethods = ['createHash', 'createHmac', 'createSign', 'createVerify', 'sign', 'verify']
const cipherMethods = ['createCipheriv', 'createDecipheriv']
const names = ['crypto', 'node:crypto']

addHook({ name: names }, crypto => {
  // Instrument for apm:crypto:operation:{start|finish|error} channels
  [
    ['checkPrime', 2], ['generateKey', 3], ['generateKeyPair', 3], ['generatePrime', 2], ['hkdf', 6, [1, 2, 3]],
    ['pbkdf2', 6, [0, 1]], ['randomBytes', 2], ['randomFill', 2], ['randomInt', 2], ['scrypt', 4, [0, 1]],
    ['sign', 4, [1, 2]], ['verify', 5, [1, 2, 3]]
  ].forEach(([method, expectedArgs, maskedArgs]) => {
    shimmer.wrap(crypto, method, fn => wrap(fn, expectedArgs, maskedArgs))
  })

  // Instrument for datadog:crypto:{hashing|cipher}:start channels
  shimmer.massWrap(crypto, hashMethods, wrapCryptoMethod(cryptoHashCh))
  shimmer.massWrap(crypto, cipherMethods, wrapCryptoMethod(cryptoCipherCh))
  return crypto
})

function wrapCryptoMethod (channel) {
  function wrapMethod (cryptoMethod) {
    return function () {
      if (channel.hasSubscribers && arguments.length > 0) {
        const algorithm = arguments[0]
        channel.publish({ algorithm })
      }
      return cryptoMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}

function wrap (fn, expectedArgs, maskedArgs = []) {
  const startCh = channel('apm:crypto:operation:start')
  const finishCh = channel('apm:crypto:operation:finish')
  const errorCh = channel('apm:crypto:operation:error')

  const wrapped = function () {
    const cb = AsyncResource.bind(arguments[arguments.length - 1])
    if (
      !startCh.hasSubscribers ||
      arguments.length < expectedArgs ||
      typeof cb !== 'function'
    ) {
      return fn.apply(this, arguments)
    }

    const startArgs = Array.from(arguments)
    startArgs.pop() // gets rid of the callback
    for (const argIndex of maskedArgs) { // Mask sensitive arguments
      if (argIndex < startArgs.length) {
        startArgs[argIndex] = null
      }
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish({
        operation: fn.name,
        args: startArgs
      })

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => asyncResource.bind(function (error) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish() // don't include successful result, they're mostly sensitive
        cb.apply(this, arguments)
      }))

      try {
        return fn.apply(this, arguments)
      } catch (error) {
        error.stack // trigger getting the stack at the original throwing point
        errorCh.publish(error)

        throw error
      }
    })
  }

  return wrapped
}
