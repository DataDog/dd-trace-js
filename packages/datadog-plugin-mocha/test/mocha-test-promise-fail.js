'use strict'

const { expect } = require('chai')

describe('mocha-test-promise-fail', () => {
  it('can do failed promise tests', () => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          expect(true).to.equal(false)
          resolve()
        } catch (e) {
          reject(e)
        }
      }, 100)
    })
  })
})
