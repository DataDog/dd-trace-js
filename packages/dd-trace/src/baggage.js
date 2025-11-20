'use strict'

const { storage } = require('../../datadog-core')
const baggageStorage = storage('baggage')

/**
 * @param {string} key
 * @param {string} value
 */
function setBaggageItem (key, value) {
  storage('baggage').enterWith({ ...baggageStorage.getStore(), [key]: value })
  return storage('baggage').getStore()
}

/**
 * @param {string} key
 */
function getBaggageItem (key) {
  return storage('baggage').getStore()?.[key]
}

function getAllBaggageItems () {
  return storage('baggage').getStore() ?? {}
}

/**
 * @param {string} keyToRemove
 * @returns {Record<string, unknown>}
 */
function removeBaggageItem (keyToRemove) {
  const { [keyToRemove]: _, ...newBaggage } = storage('baggage').getStore()
  storage('baggage').enterWith(newBaggage)
  return newBaggage
}

function removeAllBaggageItems () {
  storage('baggage').enterWith()
  return storage('baggage').getStore()
}

module.exports = {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems
}
