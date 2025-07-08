'use strict'

const sum = require('./dependency')
const { expect } = require('chai')

test('can sum', () => {
  expect(sum(1, 2)).to.equal(3)
})
