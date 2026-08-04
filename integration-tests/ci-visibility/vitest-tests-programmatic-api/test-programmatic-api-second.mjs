import { describe, test } from 'vitest'

describe('programmatic api second run', () => {
  test('is disabled by Test Management', () => {
    throw new Error('This test should have been disabled by Test Management.')
  })
})
