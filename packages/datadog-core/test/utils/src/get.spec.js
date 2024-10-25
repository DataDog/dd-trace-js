'use strict'

require('../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const get = require('../../../src/utils/src/get')

describe('get', () => {
  const obj = {
    a: {
      b: 'c'
    }
  }

  it('should return value at path', () => {
    expect(get(obj, 'a.b')).to.be.equal('c')
  })

  it('should return undefined if path does not exist', () => {
    expect(get(obj, 'd')).to.be.undefined
  })
})
