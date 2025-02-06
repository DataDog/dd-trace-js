'use strict'

const { expect } = require('chai')
const forEach = require('mocha-each')

describe('parameterized', () => {
  forEach(['parameter 1', 'parameter 2']).it('test %s', (value) => {
    expect(value.startsWith('parameter')).to.be.true
  })
})
