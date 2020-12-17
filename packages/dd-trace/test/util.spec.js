'use strict'

const { isTrue, isFalse, toKeyValuePairs } = require('../src/util')

const TRUES = [
  1,
  true,
  'true',
  'TRUE',
  'tRuE'
]
const FALSES = [
  0,
  false,
  'false',
  'FALSE',
  'fAlSe'
]

describe('util', () => {
  it('isTrue works', () => {
    TRUES.forEach((v) => {
      expect(isTrue(v)).to.equal(true)
      expect(isTrue(String(v))).to.equal(true)
    })
    FALSES.forEach((v) => {
      expect(isTrue(v)).to.equal(false)
      expect(isTrue(String(v))).to.equal(false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      expect(isFalse(v)).to.equal(true)
      expect(isFalse(String(v))).to.equal(true)
    })
    TRUES.forEach((v) => {
      expect(isFalse(v)).to.equal(false)
      expect(isFalse(String(v))).to.equal(false)
    })
  })

  it('toKeyValuePairs works', () => {
    expect(toKeyValuePairs(undefined)).to.deep.equal({})
    expect(toKeyValuePairs(null)).to.deep.equal({})
    expect(toKeyValuePairs('')).to.deep.equal({})
    expect(toKeyValuePairs('string')).to.deep.equal({})
    expect(toKeyValuePairs('string1,string2')).to.deep.equal({})
    expect(toKeyValuePairs('key:value')).to.deep.equal({ key: 'value' })
    expect(toKeyValuePairs('key1:value1,key2:value2')).to.deep.equal({ key1: 'value1', key2: 'value2' })
    expect(toKeyValuePairs('string1,key2:value2,string3')).to.deep.equal({ key2: 'value2' })
    expect(toKeyValuePairs('  key1 :  value1, key2 :  value2 ')).to.deep.equal({ key1: 'value1', key2: 'value2' })
    expect(toKeyValuePairs('key1:value1,key2:value2,')).to.deep.equal({ key1: 'value1', key2: 'value2' })
    expect(toKeyValuePairs('key1:value1,key2:value2,key1:value3')).to.deep.equal({ key1: 'value3', key2: 'value2' })
  })
})
