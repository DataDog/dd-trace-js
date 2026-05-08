import { describe, test, afterEach } from 'vitest'

describe('quarantine tests with failing afterEach', () => {
  afterEach(() => {
    throw new Error('afterEach hook failed')
  })

  test('can quarantine a test whose afterEach hook fails', () => {
    // test body passes, but afterEach throws — causing the test to be reported as failed
  })
})
