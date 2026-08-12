'use strict'

let afterEachAttempts = 0
let beforeEachAttempts = 0

describe('WebdriverIO ATR beforeEach failure', () => {
  beforeEach(() => {
    if (beforeEachAttempts++ === 0) {
      throw new Error('ATR beforeEach failure')
    }
  })

  it('does not retry the test', () => {})
})

describe('WebdriverIO ATR afterEach failure', () => {
  afterEach(() => {
    if (afterEachAttempts++ === 0) {
      throw new Error('ATR afterEach failure')
    }
  })

  it('does not retry the test', () => {})
})
