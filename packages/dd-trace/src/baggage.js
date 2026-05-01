'use strict'

const { storage } = require('../../datadog-core')

/**
 * In-process baggage map stored in async local storage. Frozen on every write.
 *
 * @see https://opentelemetry.io/docs/specs/otel/baggage/api/
 * @typedef {import('../../datadog-core/src/storage').Store<string>} BaggageStore
 */

/**
 * @type {{ enterWith: (store?: BaggageStore) => void, getStore: () => (BaggageStore | undefined) }}
 */
const baggageStorage =
  /** @type {{ enterWith: (store?: BaggageStore) => void, getStore: () => (BaggageStore | undefined) }} */ (
    /** @type {unknown} */ (storage('baggage'))
  )

const EMPTY_STORE = Object.freeze(/** @type {BaggageStore} */ ({}))

// TODO: Implement metadata https://opentelemetry.io/docs/specs/otel/baggage/api/#set-value
/**
 * @param {string} key
 * @param {string} value
 * @param {object} [metadata] Not used yet
 */
function setBaggageItem (key, value, metadata) {
  const store = baggageStorage.getStore()
  if (typeof key !== 'string' || typeof value !== 'string' || key === '') {
    return store ?? EMPTY_STORE
  }
  const newStore = Object.freeze({ ...store, [key]: value })
  baggageStorage.enterWith(newStore)
  return newStore
}

/**
 * @param {string} key
 * @returns {string | undefined}
 */
function getBaggageItem (key) {
  return baggageStorage.getStore()?.[key]
}

function getAllBaggageItems () {
  return baggageStorage.getStore() ?? EMPTY_STORE
}

/**
 * @param {string} keyToRemove No-op for non-string or empty keys.
 */
function removeBaggageItem (keyToRemove) {
  const store = baggageStorage.getStore() ?? EMPTY_STORE
  if (typeof keyToRemove !== 'string' || keyToRemove === '') {
    return store
  }
  const { [keyToRemove]: _, ...newBaggage } = store
  Object.freeze(newBaggage)
  baggageStorage.enterWith(newBaggage)
  return newBaggage
}

function removeAllBaggageItems () {
  baggageStorage.enterWith(EMPTY_STORE)
  return EMPTY_STORE
}

module.exports = {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems,
}
