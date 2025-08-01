'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const bindStartCh = channel('datadog:ldapjs:function:bind:start')
const bindFinishCh = channel('datadog:ldapjs:function:bind:finish')

function isString (value) {
  // eslint-disable-next-line unicorn/no-instanceof-builtins
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

function wrapEmitter (corkedEmitter) {
  const callbackMap = new WeakMap()

  const addListener = on => function (name, fn) {
    if (typeof fn === 'function') {
      let bindedFn = callbackMap.get(fn)
      if (!bindedFn) {
        const ctx = {}
        bindedFn = bindStartCh.runStores(ctx, () => {
          return function () {
            return bindFinishCh.runStores(ctx, () => {
              return fn.apply(this, arguments)
            })
          }
        })
        callbackMap.set(fn, bindedFn)
      }
      arguments[1] = bindedFn
    }
    return on.apply(this, arguments)
  }
  shimmer.wrap(corkedEmitter, 'on', addListener)
  shimmer.wrap(corkedEmitter, 'addListener', addListener)

  const removeListener = off => function (name, fn) {
    if (typeof fn === 'function') {
      const emitterOn = callbackMap.get(fn)
      if (emitterOn) {
        arguments[1] = emitterOn
      }
    }
    return off.apply(this, arguments)
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
      } else if (options !== null && typeof options === 'object' && options.filter && isString(options.filter)) {
        filter = options.filter
      }
      ldapSearchCh.publish({ base, filter })
    }

    return search.apply(this, arguments)
  })

  shimmer.wrap(ldapjs.Client.prototype, '_send', _send => function () {
    const callbackIndex = getCallbackArgIndex(arguments)
    if (callbackIndex > -1) {
      const callback = arguments[callbackIndex]
      // eslint-disable-next-line n/handle-callback-err
      arguments[callbackIndex] = shimmer.wrapFunction(callback, callback => function (err, corkedEmitter) {
        if (corkedEmitter !== null && typeof corkedEmitter === 'object' && typeof corkedEmitter.on === 'function') {
          wrapEmitter(corkedEmitter)
        }
        callback.apply(this, arguments)
      })
    }

    return _send.apply(this, arguments)
  })

  shimmer.wrap(ldapjs.Client.prototype, 'bind', bind => function (dn, password, controls, callback) {
    const ctx = {}
    if (typeof controls === 'function') {
      arguments[2] = bindStartCh.runStores(ctx, () => {
        return function () {
          return bindFinishCh.runStores(ctx, () => {
            return controls.apply(this, arguments)
          })
        }
      })
    } else if (typeof callback === 'function') {
      arguments[3] = bindStartCh.runStores(ctx, () => {
        return function () {
          return bindFinishCh.runStores(ctx, () => {
            return callback.apply(this, arguments)
          })
        }
      })
    }

    return bind.apply(this, arguments)
  })

  return ldapjs
})
