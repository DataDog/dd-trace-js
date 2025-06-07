'use strict'

const { storage } = require('../../datadog-core')
const baggageStorage = storage('baggage')

function setBaggageItem (key, value) {
  storage('baggage').enterWith({ ...baggageStorage.getStore(), [key]: value })
  return storage('baggage').getStore()
}

function getBaggageItem (key) {
  return storage('baggage').getStore()?.[key]
}

function getAllBaggageItems () {
  return storage('baggage').getStore() ?? {}
}

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
