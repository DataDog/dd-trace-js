'use strict'

const { storage } = require('../../../datadog-core')
const baggageStorage = storage('baggage')

function setBaggageItem (key, value) {
  storage('baggage').enterWith({ ...baggageStorage.getStore(), [key]: value })
}

function getBaggageItem (key) {
  return storage('baggage').getStore()?.[key]
}

function getAllBaggageItems () {
  return storage('baggage').getStore()
}

function removeBaggageItem (key) {
  delete storage('baggage').getStore()?.[key]
}

function removeAllBaggageItems () {
  storage('baggage').enterWith({})
}

module.exports = {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems
}
