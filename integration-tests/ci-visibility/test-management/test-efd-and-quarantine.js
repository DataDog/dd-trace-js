'use strict'

const assert = require('assert')

let globalCounter = 0

describe('efd and quarantine', () => {
  it('is a new flaky test', () => {
    // Passes on even attempts (0, 2, 4...), fails on odd (1, 3, 5...)
    assert.strictEqual((globalCounter++) % 2, 0)
  })

  it('is a quarantined failing test', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
