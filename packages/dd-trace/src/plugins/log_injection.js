'use strict'

const { LOG } = require('../../../../ext/formats')
const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * Runs the tracer's log injector and returns the populated holder, or
 * `undefined` when the propagator emitted no `dd` field (no span, no
 * service / version / env). Hot-path callers gate on the return.
 *
 * @param {object} tracer
 * @returns {{ dd: object } | undefined}
 */
function buildHolder (tracer) {
  const holder = {}
  tracer.inject(legacyStorage.getStore()?.span, LOG, holder)
  return holder.dd ? holder : undefined
}

/**
 * @param {object} message Caller-owned log record; never mutated.
 * @param {{ dd: object }} holder Holds the dd fields injected by the tracer.
 */
function messageProxy (message, holder) {
  return new Proxy(message, {
    get (target, key) {
      if (shouldOverride(target, key)) return holder.dd
      return target[key]
    },
    set (target, key, value) {
      return Reflect.set(target, key, value)
    },
    ownKeys (target) {
      const ownKeys = Reflect.ownKeys(target)
      if (!Object.hasOwn(target, 'dd') && Reflect.isExtensible(target)) {
        ownKeys.push('dd')
      }
      return ownKeys
    },
    getOwnPropertyDescriptor (target, p) {
      return Reflect.getOwnPropertyDescriptor(shouldOverride(target, p) ? holder : target, p)
    },
  })
}

/**
 * @param {object} target
 * @param {string | symbol} p
 */
function shouldOverride (target, p) {
  return p === 'dd' && !Object.hasOwn(target, p) && Reflect.isExtensible(target)
}

module.exports = { buildHolder, messageProxy }
