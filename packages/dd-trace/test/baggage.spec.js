'use strict'

require('./setup/tap')

const { expect } = require('chai')
const {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems
} = require('../src/baggage')

describe('baggage', () => {
  afterEach(() => {
    removeAllBaggageItems()
  })

  describe('setBaggageItem', () => {
    it('should set a baggage item', () => {
      const baggage = setBaggageItem('key', 'value')
      expect(baggage).to.deep.equal({ key: 'value' })
    })

    it('should merge with existing baggage items', () => {
      setBaggageItem('key1', 'value1')
      const baggage = setBaggageItem('key2', 'value2')
      expect(baggage).to.deep.equal({ key1: 'value1', key2: 'value2' })
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      setBaggageItem('key', 'value')
      expect(getBaggageItem('key')).to.equal('value')
    })

    it('should return undefined for non-existent items', () => {
      expect(getBaggageItem('missing')).to.be.undefined
    })
  })

  describe('getAllBaggageItems', () => {
    it('should get all baggage items', () => {
      setBaggageItem('key1', 'value1')
      setBaggageItem('key2', 'value2')
      expect(getAllBaggageItems()).to.deep.equal({ key1: 'value1', key2: 'value2' })
    })

    it('should return empty object when no items exist', () => {
      expect(getAllBaggageItems()).to.be.undefined
    })
  })

  describe('removeBaggageItem', () => {
    it('should remove a specific baggage item', () => {
      setBaggageItem('key1', 'value1')
      setBaggageItem('key2', 'value2')
      const baggage = removeBaggageItem('key1')
      expect(baggage).to.deep.equal({ key2: 'value2' })
    })

    it('should handle removing non-existent items', () => {
      setBaggageItem('key', 'value')
      const baggage = removeBaggageItem('missing')
      expect(baggage).to.deep.equal({ key: 'value' })
    })
  })

  describe('removeAllBaggageItems', () => {
    it('should remove all baggage items', () => {
      setBaggageItem('key1', 'value1')
      setBaggageItem('key2', 'value2')
      const baggage = removeAllBaggageItems()
      expect(baggage).to.deep.equal({})
    })
  })
})
