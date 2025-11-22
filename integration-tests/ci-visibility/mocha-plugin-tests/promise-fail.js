'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-promise-fail', () => {
  it('can do failed promise tests', () => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          assert.strictEqual(true, false)
          resolve()
        } catch (e) {
          reject(e)
        }
      }, 100)
    })
  })
})
