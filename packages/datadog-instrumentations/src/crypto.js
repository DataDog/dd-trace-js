'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const cryptoHashCh = channel('datadog:crypto:hashing:start')
const cryptoCipherCh = channel('datadog:crypto:cipher:start')

const hashMethods = ['createHash', 'createHmac', 'createSign', 'createVerify', 'sign', 'verify']
const cipherMethods = ['createCipheriv', 'createDecipheriv']
const names = ['crypto', 'node:crypto']

addHook({ name: names }, crypto => {
  shimmer.massWrap(crypto, hashMethods, wrapCryptoMethod(cryptoHashCh))
  shimmer.massWrap(crypto, cipherMethods, wrapCryptoMethod(cryptoCipherCh))
  return crypto
})

function wrapCryptoMethod (channel) {
  function wrapMethod (cryptoMethod) {
    return function () {
      if (channel.hasSubscribers && arguments.length > 0) {
        const algorithm = arguments[0]
        channel.publish({ algorithm, module: getModule(this) })
      }
      return cryptoMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}

function getModule (self) {
  return self?.__getModule ? self.__getModule() : undefined
}
