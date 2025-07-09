'use strict'

const { expect } = require('chai')

describe('failing', () => {
  it.failing('can report failed tests', () => {
    expect(1 + 2).to.equal(4)
  })

  it.failing('can report failing tests as failures', () => {
    expect(1 + 2).to.equal(3) // this passes but it should fail! So the test.status should be fail
  })
})
