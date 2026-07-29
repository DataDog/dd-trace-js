'use strict'

let earlyFlakeDetectionAttempts = 0

describe('WebdriverIO quarantined hook failure', () => {
  beforeEach(() => {
    throw new Error('quarantined hook failure')
  })

  it('is quarantined', () => {})
})

describe('WebdriverIO EFD hook failure', () => {
  beforeEach(() => {
    if (earlyFlakeDetectionAttempts++ === 1) {
      throw new Error('EFD hook failure')
    }
  })

  it('passes an EFD retry', () => {})
})
