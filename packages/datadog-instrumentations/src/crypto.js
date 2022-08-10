'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const cryptoCh = channel('asm:crypto:hashing:start')

addHook({ name: 'crypto' }, crypto => {
  shimmer.massWrap(
    crypto,
    ['createHash', 'createHmac', 'createSign', 'createVerify', 'sign', 'verify'],
    wrapMethod
  )
  return crypto
})

function wrapMethod (cryptoMethod) {
  return function () {
    if (cryptoCh.hasSubscribers) {
      if (arguments.length > 0) {
        const algorithm = arguments[0]
        cryptoCh.publish({ algorithm })
      }
    }
    return cryptoMethod.apply(this, arguments)
  }
}
