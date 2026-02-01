'use strict'

const { storage } = require('../../datadog-core')

/**
 * Spec (API semantics):
 * - OpenTelemetry Baggage API: https://opentelemetry.io/docs/specs/otel/baggage/api/
 *
 * In-process baggage is a string->string map stored in async local storage.
 * @typedef {import('../../datadog-core/src/storage').Store<string>} BaggageStore
 */

/**
 * @type {{ enterWith: (store?: BaggageStore) => void, getStore: () => (BaggageStore | undefined) }}
 */
const baggageStorage =
  /** @type {{ enterWith: (store?: BaggageStore) => void, getStore: () => (BaggageStore | undefined) }} */ (
    /** @type {unknown} */ (storage('baggage'))
  )

// TODO: Implement metadata https://opentelemetry.io/docs/specs/otel/baggage/api/#set-value
/**
 * @param {string} key
 * @param {string} value
 * @param {object} [metadata] Not used yet
 */
function setBaggageItem (key, value, metadata) {
  if (typeof key !== 'string' || typeof value !== 'string' || key === '') {
    return baggageStorage.getStore() ?? {}
  }

  const store = baggageStorage.getStore()
  const newStore = { ...store, [key]: value }
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
  return baggageStorage.getStore() ?? {}
}

/**
 * @param {string} keyToRemove
 */
function removeBaggageItem (keyToRemove) {
  const store = baggageStorage.getStore() ?? {}
  const { [keyToRemove]: _, ...newBaggage } = store
  baggageStorage.enterWith(newBaggage)
  return newBaggage
}

function removeAllBaggageItems () {
  const newContext = /** @type {BaggageStore} */ ({})
  baggageStorage.enterWith(newContext)
  return newContext
}

module.exports = {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems,
}
