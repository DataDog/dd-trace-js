'use strict'

const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

const kReq = Symbol('dd-trace.appsec.req')

/**
 * Return a new legacy-storage clone that weakly references `req`.
 *
 * The ref lives on an enumerable symbol key so it survives the
 * `{ ...store, span }` spreads performed by plugin scope handling,
 * while still allowing `req` (and therefore `res`) to be garbage
 * collected once the request is done.
 *
 * @param {object|undefined} store
 * @param {object} req
 * @returns {object}
 */
function withRequest (store, req) {
  return { ...store, [kReq]: new WeakRef(req) }
}

/**
 * Resolve the inbound request attached to a specific legacy store.
 * Prefer {@link getActiveRequest} unless you already have a store in hand.
 *
 * @param {object|undefined} store
 * @returns {object|undefined}
 */
function getRequest (store) {
  return store?.[kReq]?.deref()
}

/**
 * Resolve the inbound request attached to the currently active legacy store.
 * Shortcut for `getRequest(storage('legacy').getStore())`.
 *
 * @returns {object|undefined}
 */
function getActiveRequest () {
  return legacyStorage.getStore()?.[kReq]?.deref()
}

module.exports = {
  withRequest,
  getRequest,
  getActiveRequest,
}
