'use strict'

// TODO: It shouldn't be necessary to disable n/no-extraneous-require - Research
// eslint-disable-next-line n/no-extraneous-require
const { expect } = require('chai')
const dependency = require('./dependency')

describe('subproject-test', () => {
  it('can run', () => {
    expect(dependency(1, 2)).to.equal(3)
  })
})
