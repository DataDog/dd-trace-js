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

// Async crypto APIs that offload work to the libuv worker thread pool. The mapped sparse array
// names each callback-preceding argument position whose value should be captured on the context
// (string or number only). Unused positions are elided so iteration can skip them. Consumers of
// the context (e.g. the events profiler) read these fields as sample labels.
const asyncParamsByMethod = {
  checkPrime: [],
  generateKey: ['type'],
  generateKeyPair: ['type'],
  generatePrime: ['size'],
  hkdf: ['digest', , , , 'keylen'], // eslint-disable-line no-sparse-arrays
  pbkdf2: [, , 'iterations', 'keylen', 'digest'], // eslint-disable-line no-sparse-arrays
  randomBytes: ['size'],
  randomFill: [, 'offset', 'size'], // eslint-disable-line no-sparse-arrays
  randomInt: [],
  scrypt: [, , 'keylen'], // eslint-disable-line no-sparse-arrays
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
  return function (_, args) {
    const ctx = { operation }
    const lastIndex = args.length - 1
    // paramNames is a sparse array; for-in yields only populated slot indices, in ascending
    // numeric order, so we can break once we pass the callback position.
    for (const i in paramNames) {
      if (i >= lastIndex) break
      const name = paramNames[i]
      const value = args[i]
      if (typeof value === 'string' || typeof value === 'number') {
        ctx[name] = value
      }
    }
    return ctx
  }
}
