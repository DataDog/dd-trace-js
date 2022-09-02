'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const cryptoHashCh = channel('asm:crypto:hashing:start')
const cryptoCipherCh = channel('asm:crypto:cipher:start')

const hashMethods = ['createHash', 'createHmac', 'createSign', 'createVerify', 'sign', 'verify']
const cipherMethods = ['createCipheriv', 'createDecipheriv']

addHook({ name: 'crypto' }, crypto => {
  shimmer.massWrap(crypto, hashMethods, wrapCryptoMethod(cryptoHashCh))
  shimmer.massWrap(crypto, cipherMethods, wrapCryptoMethod(cryptoCipherCh))
  return crypto
})

function wrapCryptoMethod (channel) {
  function wrapMethod (cryptoMethod) {
    return function () {
      if (channel.hasSubscribers) {
        if (arguments.length > 0) {
          const algorithm = arguments[0]
          channel.publish({ algorithm })
        }
      }
      return cryptoMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}
