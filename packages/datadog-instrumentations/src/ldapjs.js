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

addHook({ name: 'ldapjs', versions: ['>=2'] }, ldapjs => {
  const ldapSearchCh = channel('datadog:ldapjs:client:search')

  shimmer.wrap(ldapjs.Client.prototype, 'search', search => function (base, options) {
    if (ldapSearchCh.hasSubscribers) {
      let filter = null
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
            arguments[1] = shimmer.wrap(corkedEmitter, 'on', on => function (name, fn) {
              if (typeof fn === 'function') {
                const callbackResource = new AsyncResource('bound-anonymous-fn')
                arguments[1] = callbackResource.bind(fn)
              }
              on.apply(this, arguments)
            })
          }
          callback.apply(this, arguments)
        })
      }
    }

    return _send.apply(this, arguments)
  })

  return ldapjs
})
