const { expect } = require('chai')

/* eslint-disable */
describe('test suite', () => {
  it('can run', () => {
    expect(1+1).to.equal(2)
  })
})

describe('test suite 2', () => {
  it('can run', () => {
    expect(1+1).to.equal(2)
  })
})

describe('test suite 3', () => {
  it('can run', (done) => {
    setTimeout(() => {
      done()
    }, 200)
  })
})

describe('test suite 4', () => {
  it('can run', (done) => {
    setTimeout(() => {
      done()
    }, 200)
  })
})

describe('test suite 5', () => {
  it('can run', (done) => {
    setTimeout(() => {
      done()
    }, 200)
  })
})
