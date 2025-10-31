'use strict'

const { expect } = require('chai')

let globalAttempts = 0

describe('describe', function () {
  this.retries(2)

  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('beforeEach')
  })

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('afterEach')
  })

  it('is not nested', function (done) {
    // eslint-disable-next-line no-console
    console.log('is not nested')
    try {
      expect(process.env.SHOULD_FAIL ? globalAttempts++ : 1).to.equal(1)
      done()
    } catch (error) {
      done(error)
    }
  })

  context('context', () => {
    beforeEach(() => {
      // eslint-disable-next-line no-console
      console.log('beforeEach in context')
    })

    afterEach(() => {
      // eslint-disable-next-line no-console
      console.log('afterEach in context')
    })

    it('nested test with retries', function () {
      // eslint-disable-next-line no-console
      console.log('nested test with retries')
      expect(0).to.equal(0)
    })
  })
})
