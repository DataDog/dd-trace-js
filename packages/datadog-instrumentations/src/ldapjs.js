'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function isString (value) {
  return typeof value === 'string' || value instanceof String
}

function getCallbackArgIndex (args) {
  let callbackIndex = -1
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') {
      callbackIndex = i
      break
    }
  }
  return callbackIndex
}

const emitters = new WeakMap()

function wrapEmitter (corkedEmitter) {
  shimmer.wrap(corkedEmitter, 'on', on => function (name, fn) {
    if (typeof fn === 'function') {
      const callbackResource = new AsyncResource('bound-anonymous-fn')
      const bindedFn = callbackResource.bind(fn)

      let callbackMap = emitters[this]
      if (!callbackMap) {
        callbackMap = new WeakMap()
        emitters[this] = callbackMap
      }
      callbackMap[fn] = bindedFn
      arguments[1] = bindedFn
    }
    on.apply(this, arguments)
  })

  const removeListener = off => function (name, fn) {
    if (typeof fn === 'function') {
      const emitterOn = emitters[this] && emitters[this][fn]
      if (emitterOn) {
        arguments[1] = emitterOn
      }
    }
    off.apply(this, arguments)
  }
  shimmer.wrap(corkedEmitter, 'off', removeListener)
  shimmer.wrap(corkedEmitter, 'removeListener', removeListener)
}

addHook({ name: 'ldapjs', versions: ['>=2'] }, ldapjs => {
  const ldapSearchCh = channel('datadog:ldapjs:client:search')

  shimmer.wrap(ldapjs.Client.prototype, 'search', search => function (base, options) {
    if (ldapSearchCh.hasSubscribers) {
      let filter
      if (isString(options)) {
        filter = options
      } else if (typeof options === 'object' && options.filter) {
        if (isString(options.filter)) {
          filter = options.filter
        }
      }
      ldapSearchCh.publish({ base, filter })
    }

    return search.apply(this, arguments)
  })

  shimmer.wrap(ldapjs.Client.prototype, '_send', _send => function () {
    if (ldapSearchCh.hasSubscribers) {
      const callbackIndex = getCallbackArgIndex(arguments)
      if (callbackIndex > -1) {
        const callback = arguments[callbackIndex]
        arguments[callbackIndex] = shimmer.wrap(callback, function (err, corkedEmitter) {
          if (typeof corkedEmitter === 'object' && typeof corkedEmitter['on'] === 'function') {
            wrapEmitter(corkedEmitter)
          }
          callback.apply(this, arguments)
        })
      }
    }

    return _send.apply(this, arguments)
  })

  return ldapjs
})
