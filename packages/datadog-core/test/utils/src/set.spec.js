'use strict'

require('../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const set = require('../../../src/utils/src/set')

describe('set', () => {
  const obj = {}

  it('should set value at path', () => {
    set(obj, 'a.b', 'c')
    expect(obj.a.b).to.be.equal('c')
  })
})
