import { expect, test } from 'vitest'

let attemptToFixExecutions = 0

test('does not execute a disabled browser test', () => {
  throw new Error('disabled browser test was executed')
})

test('quarantines a failing browser test', () => {
  expect(true).toBe(false)
})

test('attempts to fix a browser test', () => {
  attemptToFixExecutions++
  expect(attemptToFixExecutions).toBeGreaterThan(0)
})
