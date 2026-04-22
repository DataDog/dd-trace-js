'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const { createCallbackInstrumentor } = require('./helpers/callback-instrumentor')

const cryptoHashCh = channel('datadog:crypto:hashing:start')
const cryptoCipherCh = channel('datadog:crypto:cipher:start')

const hashMethods = ['createHash', 'createHmac', 'createSign', 'createVerify', 'sign', 'verify']
const cipherMethods = ['createCipheriv', 'createDecipheriv']

// Async crypto APIs that offload work to the libuv worker thread pool. The mapped array names each
// callback-preceding argument position whose value should be captured on the context (string or
// number only). `null` entries are unused positions. Consumers of the context (e.g. the events
// profiler) read these fields as sample labels.
const asyncParamsByMethod = {
  checkPrime: [],
  generateKey: ['type'],
  generateKeyPair: ['type'],
  generatePrime: ['size'],
  hkdf: ['digest', null, null, null, 'keylen'],
  pbkdf2: [null, null, 'iterations', 'keylen', 'digest'],
  randomBytes: ['size'],
  randomFill: [null, 'offset', 'size'],
  randomInt: [],
  scrypt: [null, null, 'keylen'],
  sign: ['algorithm'],
  verify: ['algorithm'],
}

addHook({ name: 'crypto' }, crypto => {
  shimmer.massWrap(crypto, hashMethods, wrapCryptoMethod(cryptoHashCh))
  shimmer.massWrap(crypto, cipherMethods, wrapCryptoMethod(cryptoCipherCh))

  const instrument = createCallbackInstrumentor('apm:crypto:operation')
  for (const [method, paramNames] of Object.entries(asyncParamsByMethod)) {
    if (typeof crypto[method] === 'function') {
      shimmer.wrap(crypto, method, instrument(buildAsyncContext(method, paramNames)))
    }
  }
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

function buildAsyncContext (operation, paramNames) {
  return function (thisArg, args) {
    const ctx = { operation }
    const paramCount = Math.min(paramNames.length, args.length - 1)
    for (let i = 0; i < paramCount; i++) {
      const name = paramNames[i]
      if (name) {
        const value = args[i]
        if (typeof value === 'string' || typeof value === 'number') {
          ctx[name] = value
        }
      }
    }
    return ctx
  }
}
