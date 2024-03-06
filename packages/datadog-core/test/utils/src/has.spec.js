'use strict'

require('../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const has = require('../../../src/utils/src/has')

describe('has', () => {
  const obj = {
    'a': {
      'b': 'c'
    }
  }

  it('should true if path exists', () => {
    expect(has(obj, 'a.b')).to.be.true
  })

  it('should return false if path does not exist', () => {
    expect(has(obj, 'd')).to.be.false
  })
})
