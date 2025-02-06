'use strict'

const { expect } = require('chai')

let globalCounter = 0

describe('fail', () => {
  it('occasionally fails', () => {
    expect((globalCounter++) % 2).to.equal(0)
  })
})
